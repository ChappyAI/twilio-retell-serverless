import { Context as ServerlessContext, ServerlessCallback, ServerlessFunctionSignature } from '@twilio-labs/serverless-runtime-types/types';
import { query as dbQuery } from '../utils/db_client';
import { createCarrier } from '../utils/carrier_factory';
import Twilio from 'twilio';

interface MyContext extends ServerlessContext {
  INITIAL_CALL_CALLER_ID: string;
  RETELL_AGENT_ID_INITIAL_CALL: string;
  START_CALL_FUNCTION_SID: string; // SID for start.ts
  SERVERLESS_SERVICE_SID: string;
  CARRIER: string;
  TELNYX_API_KEY: string;
  TELNYX_CONNECTION_ID: string;
}

interface HopperResult {
  hopper_id: number;
  lead_id: string;
}

interface LeadDetails {
  id: string;
  phone_number: string;
  first_name?: string;
  last_name?: string;
}

export const handler: ServerlessFunctionSignature<MyContext, {}> = async (
  context,
  event,
  callback
) => {
  console.log('Initial Dialer Service invoked.');
  const response = new Twilio.Response();
  response.appendHeader('Content-Type', 'application/json');

  let hopperEntry: HopperResult | null = null;

  try {
    const fetchAndLockQuery = `
      UPDATE hopper
      SET status = 'PROCESSING_INITIAL_CALL', updated_at = NOW()
      WHERE id = (
        SELECT id
        FROM hopper
        WHERE status = 'PENDING_INITIAL_CALL'
        ORDER BY hopper_entry_timestamp ASC, priority ASC NULLS LAST
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id AS hopper_id, lead_id;
    `;

    const hopperResults = await dbQuery<HopperResult>(fetchAndLockQuery);

    if (hopperResults.length === 0) {
      console.log('No leads in hopper with status PENDING_INITIAL_CALL.');
      response.setBody({ success: true, status: 'no_leads_found', message: 'No leads in hopper to process.' });
      return callback(null, response);
    }

    hopperEntry = hopperResults[0];
    console.log(`Processing hopper entry ID: ${hopperEntry.hopper_id}, Lead ID: ${hopperEntry.lead_id}`);

    const leadDetailsResults = await dbQuery<LeadDetails>(
      'SELECT id, phone_number, first_name, last_name FROM leads WHERE id = $1',
      [hopperEntry.lead_id]
    );

    if (leadDetailsResults.length === 0) {
      await dbQuery("UPDATE hopper SET status = 'ERROR_PROCESSING_LEAD_NOT_FOUND', updated_at = NOW() WHERE id = $1", [hopperEntry.hopper_id]);
      response.setStatusCode(500);
      response.setBody({ success: false, status: 'error_lead_not_found', message: `Lead details not found for lead_id ${hopperEntry.lead_id}.` });
      return callback(null, response);
    }
    const leadDetails = leadDetailsResults[0];
    console.log(`Fetched lead details for ${leadDetails.phone_number}`);

    const trackingId = `initial_H${hopperEntry.hopper_id}_L${hopperEntry.lead_id}_${Date.now()}`;
    await dbQuery('UPDATE hopper SET initial_call_provider_sid = $1, updated_at = NOW() WHERE id = $2', [trackingId, hopperEntry.hopper_id]);

    const carrier = createCarrier(context.CARRIER, context.getTwilioClient(), context);

    let callInitiationError = false;
    try {
      const callDetails = {
        to: leadDetails.phone_number,
        from: context.INITIAL_CALL_CALLER_ID,
        agentId: context.RETELL_AGENT_ID_INITIAL_CALL,
        callSid: trackingId, // For Twilio
        connection_id: context.TELNYX_CONNECTION_ID, // For Telnyx
      };

      console.log(`Initiating call via ${context.CARRIER} with details:`, callDetails);
      const callResult = await carrier.initiateCall(callDetails);

      let success = false;
      let provider_call_sid = null;

      if (context.CARRIER === 'twilio') {
        const startCallResponse = JSON.parse(callResult.response.body);
        if (callResult.statusCode === 200 && startCallResponse.success) {
          success = true;
          provider_call_sid = startCallResponse.call_sid;
        }
      } else if (context.CARRIER === 'telnyx') {
        if (callResult && callResult.data && callResult.data.call_control_id) {
          success = true;
          provider_call_sid = callResult.data.call_control_id;
        }
      }

      if (success) {
        console.log(`Call initiated successfully via ${context.CARRIER} for lead ${leadDetails.id}. Provider Call SID: ${provider_call_sid}`);
        response.setBody({
            success: true,
            status: 'call_initiated',
            message: `Call initiated for lead ID ${leadDetails.id}.`,
            lead_id: leadDetails.id,
            hopper_id: hopperEntry.hopper_id,
            tracking_id: trackingId,
            provider_call_sid: provider_call_sid
        });
      } else {
        callInitiationError = true;
        console.error(`Failed to initiate call via ${context.CARRIER} for lead ${leadDetails.id}. Result:`, callResult);
      }
    } catch (e) {
      callInitiationError = true;
      console.error(`Critical error initiating call for lead ${leadDetails.id}:`, e);
    }

    if (callInitiationError) {
      await dbQuery("UPDATE hopper SET status = 'ERROR_INITIATING_CALL', updated_at = NOW() WHERE id = $1", [hopperEntry.hopper_id]);
      response.setStatusCode(500);
      response.setBody({
          success: false,
          status: 'error_initiating_call',
          message: `Failed to initiate call for lead ID ${leadDetails.id}.`,
          lead_id: leadDetails.id,
          hopper_id: hopperEntry.hopper_id
      });
    }

    return callback(null, response);

  } catch (error) {
    console.error('Unhandled error in Initial Dialer Service:', error);

    if (hopperEntry && hopperEntry.hopper_id) {
      await dbQuery("UPDATE hopper SET status = 'ERROR_PROCESSING_UNHANDLED', updated_at = NOW() WHERE id = $1 AND status = 'PROCESSING_INITIAL_CALL'", [hopperEntry.hopper_id]);
    }

    response.setStatusCode(500);
    response.setBody({ success: false, status: 'internal_server_error', message: `An unexpected error occurred: ${ (error instanceof Error) ? error.message : String(error)}` });
    return callback(null, response);
  }
};

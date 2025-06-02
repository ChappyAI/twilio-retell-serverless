import { Context as ServerlessContext, ServerlessCallback, TwilioClient } from '@twilio-labs/serverless-runtime-types/types';
import { ContactCadenceState } from '../types/cadence_state';
import { getCadenceRules, CadenceRulesConfig, CadenceDispositionRule } from '../utils/cadence_rules'; // Import shared rules

import { Context as ServerlessContext, ServerlessCallback, TwilioClient } from '@twilio-labs/serverless-runtime-types/types';
import { ContactCadenceState } from '../types/cadence_state';
// Ensure all necessary types from the shared rules are imported
import { getCadenceRules, CadenceRulesConfig, CadenceDispositionRule, CadenceRuleSegment, CadenceRuleDelay } from '../utils/cadence_rules';

// Define MyContext to include environment variables
interface MyContext extends ServerlessContext {
  TWILIO_SYNC_SERVICE_SID: string;
  SEGMENT_WRITE_KEY?: string;
  ACCOUNT_SID: string;
  AUTH_TOKEN: string;
  TWILIO_WORKSPACE_SID?: string;
  TWILIO_WORKFLOW_SID?: string;
  RETELL_HANDOFF_DISPOSITIONS?: string;
  MANAGE_CONTACT_STATE_FUNCTION_SID?: string;
  ADD_EVENT_FUNCTION_SID?: string;
  CREATE_TASK_FUNCTION_SID?: string;
  SERVERLESS_SERVICE_SID: string;
}

// Interface for the expected Retell webhook payload
// This should be updated based on actual Retell documentation.
// This is a simplified example; refer to Retell documentation for the exact structure.
interface RetellCallOutcomePayload {
  call_id: string;                  // Retell's internal call ID
  twilio_call_sid: string;          // Twilio Call SID
  phone_number: string;             // E.164 format contact phone number
  disposition: string;              // e.g., "CALL_COMPLETED_HUMAN_HANDOFF", "CALL_COMPLETED_NO_ANSWER", "CALL_FAILED_VOICEMAIL_DETECTED"
  call_ended_timestamp: string;     // ISO 8601 timestamp
  transcript?: string;
  transcript_summary?: string;      // Summary of the conversation if available
  recording_url?: string;
  metadata?: { [key: string]: any }; // Any custom metadata passed to Retell or generated
  // Add other fields as per Retell's actual payload structure
}

// Response from invoking another serverless function
interface InvokedFunctionResponse {
  success: boolean;
  message?: string;
  data?: any; // Adjust based on what the invoked function returns
}


export const handler = async (
  context: MyContext,
  event: RetellCallOutcomePayload, // Assuming event comes directly as payload
  callback: ServerlessCallback
) => {
  console.log('Retell Call Outcome Webhook received:', JSON.stringify(event, null, 2));

  const response = new Twilio.Response();
  response.appendHeader('Content-Type', 'application/json');

  // Basic payload validation
  if (!event.twilio_call_sid || !event.phone_number || !event.disposition || !event.call_ended_timestamp) {
    console.error('Validation Error: Missing required fields in Retell payload.');
    response.setStatusCode(400);
    response.setBody({ success: false, message: 'Missing required fields: twilio_call_sid, phone_number, disposition, call_ended_timestamp are required.' });
    return callback(null, response);
  }

  const twilioClient = context.getTwilioClient();
  const serverlessServiceSid = context.SERVERLESS_SERVICE_SID;
  const manageContactStateFunction = context.MANAGE_CONTACT_STATE_FUNCTION_SID || 'manage_contact_state';

  try {
    // Step 1: Fetch current contact state
    console.log(`Fetching contact state for ${event.phone_number}...`);
    let fetchedContactState: ContactCadenceState | null = null;
    try {
      const stateResult = await twilioClient.serverless.services(serverlessServiceSid).functions(manageContactStateFunction).invocations.create({
        action: 'get',
        phoneNumber: event.phone_number,
      });
      // @ts-ignore
      const stateResponse = JSON.parse(stateResult.response.body);
      // @ts-ignore
      if (stateResult.statusCode === 200 && stateResponse) {
        // @ts-ignore
        if (stateResponse.success === false && stateResponse.message === 'Contact not found') {
          fetchedContactState = null;
          console.log(`Contact ${event.phone_number} not found.`);
        } else {
          fetchedContactState = stateResponse as ContactCadenceState;
          console.log('Current contact state fetched:', fetchedContactState);
        }
      } else { // @ts-ignore
        console.warn(`Could not fetch contact state for ${event.phone_number}. Status: ${stateResult.statusCode}, Body: ${stateResult.response.body}. Assuming new contact.`);
        fetchedContactState = null;
      }
    } catch (fetchError) { // @ts-ignore
      console.error(`Error invoking getContactState for ${event.phone_number}: ${fetchError.message}. Assuming new contact.`, fetchError);
      fetchedContactState = null;
    }

    // Step 2: Initialize or update contact state based on outcome
    let contactState: ContactCadenceState;
    if (fetchedContactState) {
      contactState = { ...fetchedContactState };
      contactState.attemptCount = (contactState.attemptCount || 0) + 1;
    } else {
      // New contact: initialize state
      contactState = {
        phoneNumber: event.phone_number,
        attemptCount: 1,
        status: 'PENDING', // Initial status, will be updated by rules
        // leadId, metadata can be set if provided in webhook or via other means
      };
      console.warn(`No prior contact state found for ${event.phone_number}. Initializing new state.`);
    }

    // Update common fields based on webhook payload
    contactState.lastCallSid = event.twilio_call_sid;
    contactState.lastCallDisposition = event.disposition;
    contactState.lastAttemptTimestamp = event.call_ended_timestamp;
    contactState.currentCallSid = undefined; // Clear the specific call SID for this attempt
    contactState.metadata = { ...(contactState.metadata || {}), retellCallId: event.call_id, lastWebhookTimestamp: new Date().toISOString() };


    // Step 3: Apply Cadence Rules for Status and nextCallTimestamp
    const cadenceRules = getCadenceRules();
    const dispositionKey = contactState.lastCallDisposition || 'DEFAULT';
    // Use 'NEW_LEAD' rule if it's the very first attempt outcome for a lead not previously in system,
    // otherwise use specific disposition or DEFAULT.
    // The `contactState.attemptCount` has been incremented to reflect the call that just finished.
    const rules = getCadenceRules();
    const dispositionKey = contactState.lastCallDisposition || 'DEFAULT'; // Use DEFAULT if no disposition

    // Special handling for NEW_LEAD rule if this is the first attempt for a newly created contact state
    // This ensures that the NEW_LEAD rule's segments (which expect attemptCount 0 or 1) are correctly applied.
    // However, the CadenceEngine handles attempt 0. Webhook gets outcome of attempt 1.
    // So, effectiveRuleKey will usually be based on actual lastCallDisposition.
    const currentRule = rules[dispositionKey] || rules.DEFAULT; // Fallback to DEFAULT rule

    console.log(`Applying rule for disposition: "${dispositionKey}", Effective Rule Key: "${dispositionKey}". Attempt count: ${contactState.attemptCount}.`);

    // Default to current priority or disposition default
    contactState.hopperPriority = contactState.hopperPriority ?? currentRule.defaultHopperPriority;

    // Handle explicit terminal dispositions first
    const handoffDispositions = (context.RETELL_HANDOFF_DISPOSITIONS || "CALL_COMPLETED_HUMAN_HANDOFF,CALL_TRANSFERRED").split(',');

    if (dispositionKey === 'APPOINTMENT_SCHEDULED_AI' || currentRule.finalStatusOnExhaustion === 'COMPLETED_SUCCESS') { // Check rule's intent
        contactState.status = 'COMPLETED_SUCCESS';
        contactState.nextCallTimestamp = undefined;
        contactState.hopperPriority = undefined; // Or a low priority for completed leads
        console.log(`Terminal success disposition or rule for ${dispositionKey}. Status: COMPLETED_SUCCESS.`);
    } else if (handoffDispositions.includes(dispositionKey)) {
        contactState.status = 'PAUSED';
        contactState.nextCallTimestamp = undefined;
        // Potentially set a specific hopperPriority for PAUSED handoff items if needed
        console.log(`Handoff disposition ${dispositionKey}. Status: PAUSED.`);
    } else {
        // Find matching segment based on current (incremented) attemptCount
        const matchedSegment = currentRule.segments.find(segment =>
            contactState.attemptCount >= segment.callCountMin && contactState.attemptCount <= segment.callCountMax
        );

        if (matchedSegment) {
            console.log(`Matched segment for attempt count ${contactState.attemptCount}:`, matchedSegment);
            contactState.status = 'ACTIVE'; // Mark as active for the next attempt

            const delay = matchedSegment.delay;
            let nextCallDate = new Date(); // Calculate from now
            nextCallDate.setDate(nextCallDate.getDate() + delay.days);
            nextCallDate.setHours(nextCallDate.getHours() + delay.hours);
            nextCallDate.setMinutes(nextCallDate.getMinutes() + delay.minutes);
            nextCallDate.setSeconds(nextCallDate.getSeconds() + delay.seconds);
            contactState.nextCallTimestamp = nextCallDate.toISOString();

            // Apply priority override from segment, or fallback to disposition default, or keep existing.
            if (matchedSegment.hopperPriorityOverride !== undefined) {
                contactState.hopperPriority = matchedSegment.hopperPriorityOverride;
            }
            // If no override, hopperPriority remains as it was (either from before, or set by disposition default above)

            console.log(`Next call for ${contactState.phoneNumber} scheduled at ${contactState.nextCallTimestamp}. Hopper Priority: ${contactState.hopperPriority}`);
        } else {
            // No matching segment found - means attempts for this disposition are exhausted according to defined segments
            console.log(`No matching segment for disposition "${dispositionKey}" and attempt count ${contactState.attemptCount}. Applying final status.`);
            contactState.status = currentRule.finalStatusOnExhaustion;
            contactState.nextCallTimestamp = undefined; // No next call
            // Hopper priority might be cleared or set to a low value for exhausted leads
            contactState.hopperPriority = undefined; // Or specific low priority
        }
    }

    // Step 4: Save updated state
    try {
      console.log(`Updating contact state for ${event.phone_number} with final computed state:`, contactState);
      const updateResult = await twilioClient.serverless.services(serverlessServiceSid).functions(manageContactStateFunction).invocations.create({
        action: 'addOrUpdate',
        state: contactState, // Send the complete, updated state
      });
      // @ts-ignore
      console.log('Contact state update invocation result:', JSON.parse(updateResult.response.body));
    } catch (updateError) { // @ts-ignore
      console.error(`Error invoking addOrUpdateContact for ${event.phone_number}: ${updateError.message}`, updateError);
    }

    // Step 5: Log event to Segment
    const addEventFunction = context.ADD_EVENT_FUNCTION_SID || 'add_event';
    if (context.SEGMENT_WRITE_KEY && addEventFunction) {
      const eventProperties = {
        call_sid: event.twilio_call_sid,
        retell_call_id: event.call_id,
        phone_number: event.phone_number,
        disposition: event.disposition,
        summary: event.transcript_summary,
        call_ended_timestamp: event.call_ended_timestamp,
        attempt_count: contactState.attemptCount,
        final_status: contactState.status,
        next_call_timestamp: contactState.nextCallTimestamp,
      };
      try {
        console.log('Logging event to Segment:', eventProperties);
        // @ts-ignore
        await twilioClient.serverless.services(serverlessServiceSid).functions(addEventFunction).invocations.create({
          userId: event.phone_number,
          eventName: 'Retell Call Outcome Processed',
          properties: eventProperties,
        });
        console.log('Segment event logged successfully.');
      } catch (segmentError) { // @ts-ignore
        console.error('Error logging event to Segment:', segmentError.message);
      }
    }

    // Step 6: Trigger TaskRouter for Human Handoff
    const createTaskFunction = context.CREATE_TASK_FUNCTION_SID || 'create_task';
    // Check against updated contactState.status as rules might have set it to PAUSED for handoff
    if (context.TWILIO_WORKSPACE_SID && context.TWILIO_WORKFLOW_SID && createTaskFunction &&
        (handoffDispositions.includes(event.disposition) || contactState.status === 'PAUSED' && handoffDispositions.includes(contactState.lastCallDisposition || ''))) {
      const taskAttributes = {
        twilio_call_sid: event.twilio_call_sid,
        retell_call_id: event.call_id,
        phone_number: event.phone_number,
        disposition: event.disposition, // The actual disposition from Retell
        current_contact_status: contactState.status,
        transcript_summary: event.transcript_summary,
        customer_name: event.metadata?.customer_name || contactState.metadata?.customer_name || 'Unknown',
        lead_id: contactState.leadId,
      };
      try {
        console.log('Triggering TaskRouter task for handoff:', taskAttributes);
        // @ts-ignore
        await twilioClient.serverless.services(serverlessServiceSid).functions(createTaskFunction).invocations.create({
          attributes: taskAttributes,
          workflowSid: context.TWILIO_WORKFLOW_SID,
        });
        console.log('TaskRouter task created successfully for handoff.');
      } catch (taskRouterError) { // @ts-ignore
        console.error('Error creating TaskRouter task:', taskRouterError.message);
      }
    }

    // Step 7: Respond to Webhook
    response.setStatusCode(200);
    response.setBody({ success: true, message: 'Webhook received and processed.' });
    return callback(null, response);

  } catch (error) {
    // @ts-ignore
    console.error('Unhandled error in Retell Call Outcome Webhook:', error.message, error.stack);
    response.setStatusCode(500);
    // @ts-ignore
    response.setBody({ success: false, message: `Internal Server Error: ${error.message}` });
    return callback(null, response);
  }
};

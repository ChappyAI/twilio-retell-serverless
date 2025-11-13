import { Carrier } from '../types/carrier';
import VoiceResponse from 'twilio/lib/twiml/VoiceResponse';

export class TwilioCarrier implements Carrier {
  private twilioClient: any;
  private context: any;

  constructor(twilioClient: any, context: any) {
    this.twilioClient = twilioClient;
    this.context = context;
  }

  async initiateCall(callDetails: any): Promise<any> {
    const { to, from, agentId, callSid } = callDetails;
    const params = {
      To: to,
      From: from,
      agent_id: agentId,
      CallSid: callSid,
    };

    return this.twilioClient.serverless
      .services(this.context.SERVERLESS_SERVICE_SID)
      .functions(this.context.START_CALL_FUNCTION_SID)
      .invocations.create(params);
  }

  handleWebhook(request: any): any {
    const { call_id } = request;
    const response = new VoiceResponse();
    const dial = response.dial();
    dial.sip(`sip:${call_id}@5t4n6j0wnrl.sip.livekit.cloud`);
    return response;
  }
}

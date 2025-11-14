import { Carrier } from '../types/carrier';
import Telnyx from 'telnyx';

export class TelnyxCarrier implements Carrier {
  private telnyxClient: any;

  constructor(apiKey: string) {
    this.telnyxClient = new (Telnyx as any)({ apiKey });
  }

  async initiateCall(callDetails: any): Promise<any> {
    const { to, from, connection_id } = callDetails;
    return this.telnyxClient.calls.create({
      to,
      from,
      connection_id,
    });
  }

  handleWebhook(request: any): any {
    // For Telnyx, the equivalent of TwiML's <Dial><Sip> is to use the Dial command.
    // This will be handled in the webhook that receives the call.
    // The response will be XML-based, similar to TwiML.
    const { call_id } = request;
    const response = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Dial>
        <Sip>sip:${call_id}@5t4n6j0wnrl.sip.livekit.cloud</Sip>
    </Dial>
</Response>`;
    return response;
  }
}

import { Carrier } from '../types/carrier';
import { TwilioCarrier } from './twilio_carrier';
import { TelnyxCarrier } from './telnyx_carrier';

export function createCarrier(
  carrier: string,
  twilioClient: any,
  context: any
): Carrier {
  switch (carrier) {
    case 'twilio':
      return new TwilioCarrier(twilioClient, context);
    case 'telnyx':
      return new TelnyxCarrier(context.TELNYX_API_KEY);
    default:
      throw new Error(`Unsupported carrier: ${carrier}`);
  }
}

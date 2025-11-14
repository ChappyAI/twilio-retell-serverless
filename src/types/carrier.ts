export interface Carrier {
  initiateCall(callDetails: any): Promise<any>;
  handleWebhook(phoneCallResponse: any): any;
}

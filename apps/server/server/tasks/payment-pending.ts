/** An expected settlement wait, not a failed payment attempt. */
export class PaymentPending extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PaymentPending";
  }
}

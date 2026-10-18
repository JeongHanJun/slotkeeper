// The subset of PayPal REST shapes this app sends and reads.
// Field names follow the public reference (Orders v2, Payments v2, Webhooks v1)
// and were compared with real sandbox answers; see docs/SANDBOX_SHAPES.md.

export interface Money {
  currency_code: string;
  value: string;
}

export interface Link {
  href: string;
  rel: string;
  method?: string;
}

// POST /v2/checkout/orders
export interface CreateOrderRequest {
  intent: "CAPTURE";
  purchase_units: {
    reference_id: string;
    custom_id: string;
    description: string;
    amount: Money;
  }[];
  payment_source: PayPalSource | CardSource;
}

export interface PayPalSource {
  paypal: {
    experience_context: {
      brand_name: string;
      user_action: "PAY_NOW";
      shipping_preference: "NO_SHIPPING";
      return_url: string;
      cancel_url: string;
    };
  };
}

// Paying with a card number sent by the server. The desk never does this; the
// sandbox test suite uses it with PayPal's published test cards, on accounts
// that have card processing switched on.
export interface CardSource {
  card: {
    number: string;
    expiry: string;
    security_code: string;
    name: string;
    billing_address?: Record<string, string>;
  };
}

export type OrderStatus =
  | "CREATED"
  | "PAYER_ACTION_REQUIRED"
  | "APPROVED"
  | "COMPLETED"
  | "VOIDED";

export interface Capture {
  id: string;
  status: "COMPLETED" | "PENDING" | "DECLINED" | "REFUNDED" | "PARTIALLY_REFUNDED";
  amount: Money;
  final_capture?: boolean;
  custom_id?: string;
  seller_receivable_breakdown?: {
    gross_amount: Money;
    paypal_fee: Money;
    net_amount: Money;
  };
  supplementary_data?: { related_ids?: { order_id?: string } };
  create_time?: string;
  update_time?: string;
  links?: Link[];
}

export interface Order {
  id: string;
  status: OrderStatus;
  intent?: "CAPTURE";
  create_time?: string;
  payment_source?: Record<string, unknown>;
  payer?: { email_address?: string; payer_id?: string; name?: { given_name?: string; surname?: string } };
  purchase_units?: {
    reference_id?: string;
    custom_id?: string;
    description?: string;
    amount?: Money;
    payee?: { email_address?: string; merchant_id?: string; display_data?: { brand_name?: string } };
    payments?: { captures?: Capture[] };
  }[];
  links?: Link[];
}

// POST /v2/payments/captures/{id}/refund
export interface RefundRequest {
  amount?: Money;
  note_to_payer?: string;
}

export interface Refund {
  id: string;
  status: "COMPLETED" | "PENDING" | "FAILED" | "CANCELLED";
  amount?: Money;
  note_to_payer?: string;
  seller_payable_breakdown?: {
    gross_amount?: Money;
    paypal_fee?: Money;
    net_amount?: Money;
    total_refunded_amount?: Money;
  };
  create_time?: string;
  update_time?: string;
  links?: Link[];
}

// Body PayPal posts to the webhook listener.
export interface WebhookEvent<R = unknown> {
  id: string;
  event_version: string;
  create_time: string;
  resource_type: string;
  resource_version?: string;
  event_type: string;
  summary: string;
  resource: R;
  links: Link[];
}

// Error body for 4xx/5xx responses.
export interface ErrorBody {
  name: string;
  message: string;
  debug_id?: string;
  details?: { issue: string; description?: string; field?: string; value?: string; location?: string }[];
  links?: Link[];
}

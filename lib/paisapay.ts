import crypto from 'crypto';

export const PAISAPAY_CREATE_ORDER_URL = 'https://api.paisapay.site/create_order.php';
export const PAISAPAY_PAYOUT_URL = 'https://api.paisapay.site/create_payout.php';

export interface PaisaPayOrderPayload {
  amount: string;     // e.g. "500.00"
  mobile: string;     // 10-digit mobile number
  udf1: string;       // internal pay_request id (UUID)
}

export interface PaisaPayWebhookPayload {
  order_id: string;
  amount: number | string;
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  utr?: string;
  payment_time?: string;
  udf1?: string;
}

/**
 * Encrypt JSON payload using AES-256-ECB (Base64 output)
 */
export function encryptPayload(data: Record<string, unknown>, secretKey: string): string {
  const jsonString = JSON.stringify(data);
  const cipher = crypto.createCipheriv('aes-256-ecb', Buffer.from(secretKey, 'utf8'), '');
  let encrypted = cipher.update(jsonString, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  return encrypted;
}

/**
 * Decrypt incoming Base64 AES-256-ECB payload from Webhook
 */
export function decryptPayload<T = PaisaPayWebhookPayload>(encryptedBase64: string, secretKey: string): T {
  const cleanBase64 = encryptedBase64.replace(/ /g, '+');
  const decipher = crypto.createDecipheriv('aes-256-ecb', Buffer.from(secretKey, 'utf8'), '');
  let decrypted = decipher.update(cleanBase64, 'base64', 'utf8');
  decrypted += decipher.final('utf8');
  return JSON.parse(decrypted);
}

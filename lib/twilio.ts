import twilio from 'twilio';
import sgMail from '@sendgrid/mail';
import nodemailer from 'nodemailer';

// Define service availability
let twilioClient: any = null;
let useSendGrid = false;

// 1. Initialize Twilio client if keys exist
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;
const fromPhone = process.env.TWILIO_PHONE_NUMBER;

if (accountSid && authToken && fromPhone) {
  try {
    twilioClient = twilio(accountSid, authToken);
    console.info('Twilio SMS service initialized successfully.');
  } catch (err) {
    console.error('Failed to initialize Twilio SMS client:', err);
  }
} else {
  console.warn('Twilio keys are not set. SMS sending will be simulated.');
}

// 2. Initialize SendGrid client if key exists
const sendgridApiKey = process.env.SENDGRID_API_KEY;
const fromEmail = process.env.SENDGRID_FROM_EMAIL;

if (sendgridApiKey && fromEmail) {
  try {
    sgMail.setApiKey(sendgridApiKey);
    useSendGrid = true;
    console.info('SendGrid email service initialized successfully.');
  } catch (err) {
    console.error('Failed to initialize SendGrid client:', err);
  }
} else {
  console.warn('SendGrid keys not set. Email service will fall back to Gmail SMTP.');
}

// 3. Nodemailer transporter fallback for Gmail SMTP
function getNodemailerTransporter() {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;

  if (!user || !pass) {
    throw new Error('Missing fallback email env vars: GMAIL_USER and/or GMAIL_APP_PASSWORD');
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user, pass },
  });
}

/**
 * Sends an SMS using APItxt (primary) or Twilio (fallback).
 * If neither is configured, logs the message instead (simulation).
 * Formats the number to E.164 if it's a simple 10-digit number.
 */
export async function sendSms(
  to: string,
  body: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (process.env.DISABLE_SMS === 'true') {
    console.info(`[SMS DISABLED BY ENV] Skipped sending SMS to ${to}`);
    return { success: true, messageId: 'sms-disabled-by-env' };
  }

  let formattedTo = to.trim();
  
  // Format simple 10-digit number to E.164. Assumes India code (+91) as default.
  if (/^\d{10}$/.test(formattedTo)) {
    formattedTo = `+91${formattedTo}`;
  } else if (/^\d{12}$/.test(formattedTo) && formattedTo.startsWith('91')) {
    formattedTo = `+${formattedTo}`;
  }

  const apitxtAuthKey = process.env.APITXT_AUTH_KEY;
  if (apitxtAuthKey) {
    try {
      // APItxt typically expects numbers without the + sign
      const mobileForApitxt = formattedTo.replace('+', '');
      
      const res = await fetch('https://apitxt.com/api/sendMsg', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          authkey: apitxtAuthKey,
          mobiles: mobileForApitxt,
          message: body,
          sender: 'MARGIN', // NOTE: Requires an approved 6-character sender ID
          route: '4',       // 4 is typically Transactional route
          // template_id: '...', // Required for DLT compliance in India
          // pe_id: '...'        // Required for DLT compliance in India
        })
      });
      
      const data = await res.json();
      if (data.status === 'success' || data.status === 'OK') {
        console.info(`SMS sent via APItxt to ${formattedTo}.`);
        return { success: true, messageId: data.data?.msg_id || 'apitxt-success' };
      } else {
        console.error(`Failed to send SMS via APItxt to ${formattedTo}:`, data);
        console.info('Attempting fallback to Twilio...');
      }
    } catch (err: any) {
      console.error(`Failed to send SMS via APItxt to ${formattedTo}:`, err);
      console.info('Attempting fallback to Twilio...');
    }
  }

  if (!twilioClient || !fromPhone) {
    console.info(`[SMS SIMULATION] To: ${formattedTo} | Body: ${body}`);
    return { success: true, messageId: 'simulated-msg-id' };
  }

  try {
    const message = await twilioClient.messages.create({
      body,
      from: fromPhone,
      to: formattedTo,
    });
    console.info(`SMS sent via Twilio to ${formattedTo}. SID: ${message.sid}`);
    return { success: true, messageId: message.sid };
  } catch (err: any) {
    console.error(`Failed to send SMS via Twilio to ${formattedTo}:`, err);
    return { success: false, error: err.message || String(err) };
  }
}

/**
 * Sends an OTP SMS using APItxt's dedicated OTP API (primary) or generic SMS (fallback).
 * Using the OTP API bypasses the strict template and sender ID requirements for general SMS.
 */
export async function sendOtpSms(
  to: string,
  otp: string,
  fallbackBody: string
): Promise<{ success: boolean; messageId?: string; error?: string }> {
  if (process.env.DISABLE_SMS === 'true') {
    console.info(`[SMS DISABLED BY ENV] Skipped sending OTP SMS to ${to}`);
    return { success: true, messageId: 'sms-disabled-by-env' };
  }

  let formattedTo = to.trim();
  
  if (/^\d{10}$/.test(formattedTo)) {
    formattedTo = `+91${formattedTo}`;
  } else if (/^\d{12}$/.test(formattedTo) && formattedTo.startsWith('91')) {
    formattedTo = `+${formattedTo}`;
  }

  const apitxtAuthKey = process.env.APITXT_AUTH_KEY;
  if (apitxtAuthKey) {
    try {
      const mobileForApitxt = formattedTo.replace('+', '');
      
      const res = await fetch('https://apitxt.com/api/sendOTP', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          authkey: apitxtAuthKey,
          mobile: mobileForApitxt,
          otp: otp
        }).toString()
      });
      
      const data = await res.json();
      if (data.status === 'success' || data.status === 'OK') {
        console.info(`OTP sent via APItxt to ${formattedTo}.`);
        return { success: true, messageId: data.data?.msg_id || 'apitxt-otp-success' };
      } else {
        console.error(`Failed to send OTP via APItxt to ${formattedTo}:`, data);
        // Fall back to generic sendSms
      }
    } catch (err: any) {
      console.error(`Failed to send OTP via APItxt to ${formattedTo}:`, err);
      // Fall back to generic sendSms
    }
  }

  return sendSms(formattedTo, fallbackBody);
}

/**
 * Sends an email using Twilio Comms Email API.
 */
async function sendTwilioEmail(
  to: string,
  subject: string,
  html: string,
  text: string
): Promise<{ success: boolean; error?: string }> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = process.env.TWILIO_AUTH_TOKEN?.trim();
  const fromEmail = process.env.TWILIO_EMAIL_FROM?.trim() || `${accountSid}@twilio.email`;
  const fromName = process.env.TWILIO_EMAIL_FROM_NAME?.trim() || 'MarginApex';

  if (!accountSid || !authToken) {
    return { success: false, error: 'Twilio credentials not configured' };
  }

  try {
    const authHeader = 'Basic ' + Buffer.from(`${accountSid}:${authToken}`).toString('base64');
    const res = await fetch('https://comms.twilio.com/v1/Emails', {
      method: 'POST',
      headers: {
        Authorization: authHeader,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: {
          address: fromEmail,
          name: fromName,
        },
        to: [{ address: to }],
        content: {
          subject,
          html,
          text,
        },
      }),
    });

    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      console.info(`[Twilio Email] Sent email successfully to ${to}`);
      return { success: true };
    } else {
      const errDetail = data?.message || JSON.stringify(data);
      console.error(`[Twilio Email] API Error (${res.status}): ${errDetail}`);
      return { success: false, error: errDetail };
    }
  } catch (err: any) {
    console.error('[Twilio Email] Error sending email:', err);
    return { success: false, error: err?.message || String(err) };
  }
}

/**
 * Sends an email using Twilio Comms Email API (primary), SendGrid (secondary), or Gmail SMTP (fallback).
 */
export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  text: string
): Promise<{ success: boolean; error?: string }> {
  const recipient = to.trim().toLowerCase();

  // 1. Try Twilio Email API first
  if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
    const twilioRes = await sendTwilioEmail(recipient, subject, html, text);
    if (twilioRes.success) {
      return { success: true };
    }
    console.warn('[Twilio Email] Failed, attempting fallback...');
  }

  // 2. Try SendGrid if configured
  if (useSendGrid && fromEmail) {
    try {
      await sgMail.send({
        to: recipient,
        from: fromEmail,
        subject,
        text,
        html,
      });
      console.info(`Email sent via SendGrid to ${recipient}`);
      return { success: true };
    } catch (err: any) {
      console.error(`Failed to send email via SendGrid to ${recipient}:`, err);
      console.info('Attempting fallback to Gmail SMTP...');
    }
  }

  // 3. Fallback to Nodemailer / Gmail SMTP
  try {
    const transporter = getNodemailerTransporter();
    const gmailUser = process.env.GMAIL_USER;
    const appName = process.env.NEXT_PUBLIC_APP_NAME || 'RupeeFX Trading';
    await transporter.sendMail({
      from: `"${appName}" <${gmailUser}>`,
      to: recipient,
      subject,
      text,
      html,
    });
    console.info(`Email sent via Gmail SMTP fallback to ${recipient}`);
    return { success: true };
  } catch (err: any) {
    console.error(`Failed to send email via fallback to ${recipient}:`, err);
    return { success: false, error: err.message || String(err) };
  }
}


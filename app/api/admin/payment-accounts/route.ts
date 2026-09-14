/**
 * GET /api/admin/payment-accounts
 * POST /api/admin/payment-accounts
 *
 * Super-admin-only endpoints for managing payment accounts.
 *
 * GET  — Returns all payment accounts ordered by sort_order ASC.
 * POST — Creates a new payment account with QR image upload to Supabase Storage.
 *
 * Validates: Requirements 25.1, 25.2, 25.3, 25.4, 25.5, 25.6, 25.13, 26.1, 26.2, 26.3
 */

import { requireAdmin } from '../_auth';
import { getRole } from '@/lib/auth';

// ---------------------------------------------------------------------------
// GET handler
// ---------------------------------------------------------------------------

/**
 * GET /api/admin/payment-accounts
 *
 * Returns all payment accounts ordered by sort_order ASC.
 *
 * Validates: Requirements 25.1, 25.2, 26.1
 */
export async function GET(request: Request): Promise<Response> {
  try {
    // Step 1: Authenticate and authorize — admin or super_admin
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;
    const callerRole = getRole(callerUser);

    let filterStr = 'created_by.is.null'; // Always include global accounts with null created_by
    if (callerRole === 'super_admin') {
      // Fetch all admins and super_admins
      const { data: adminProfiles } = await adminClient
        .from('profiles')
        .select('id')
        .in('role', ['admin', 'super_admin']);
      
      const adminIds = adminProfiles?.map((p: any) => p.id) || [];
      if (adminIds.length > 0) {
        filterStr = `created_by.in.(${adminIds.join(',')}),` + filterStr;
      }
    } else {
      // admin only sees their own and globals
      filterStr = `created_by.eq.${callerUser.id},` + filterStr;
    }

    // Step 2: Query payment_accounts ordered by sort_order ASC
    // Validates: Requirements 25.2
    const { data, error } = await adminClient
      .from('payment_accounts')
      .select('*')
      .or(filterStr)
      .order('sort_order', { ascending: true });

    if (error) {
      console.error('[GET /api/admin/payment-accounts] DB error:', error.message);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Validates: Requirements 25.2
    return Response.json(data ?? [], { status: 200 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// POST handler
// ---------------------------------------------------------------------------

/**
 * POST /api/admin/payment-accounts
 *
 * Creates a new payment account. Expects multipart/form-data with:
 *   - account_holder (string, required)
 *   - bank_name      (string, required)
 *   - account_no     (string, required)
 *   - ifsc           (string, required)
 *   - upi_id         (string, required)
 *   - qr_image       (File, required)
 *
 * Uploads qr_image to Supabase Storage bucket 'payment-qr-codes', then inserts
 * the row into payment_accounts with the resulting public URL.
 *
 * Validates: Requirements 25.3, 25.4, 25.5, 25.6, 25.13, 26.2, 26.3
 */
export async function POST(request: Request): Promise<Response> {
  try {
    // Step 1: Authenticate and authorize — admin or super_admin
    // Validates: Requirements 25.3, 26.2
    const authResult = await requireAdmin(request);
    if (authResult instanceof Response) return authResult;
    const { adminClient, callerUser } = authResult;

    // Step 2: Parse multipart/form-data
    // Validates: Requirements 25.4
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return Response.json({ error: 'Invalid form data' }, { status: 400 });
    }

    // Step 3: Extract and validate required text fields
    // Validates: Requirements 25.5
    const requiredTextFields = [
      'account_holder',
      'bank_name',
      'account_no',
      'ifsc',
      'upi_id',
    ] as const;

    const textValues: Record<string, string> = {};
    for (const fieldName of requiredTextFields) {
      const value = formData.get(fieldName);
      if (!value || typeof value !== 'string' || value.trim() === '') {
        return Response.json(
          { error: `Missing required field: ${fieldName}` },
          { status: 400 },
        );
      }
      textValues[fieldName] = value.trim();
    }

    // Step 4: Extract and validate QR image file (Optional)
    const qrImageFile = formData.get('qr_image');
    let qrImageUrl: string = '';

    if (qrImageFile && qrImageFile instanceof File && qrImageFile.size > 0) {
      // Step 5: Upload QR image to Supabase Storage
      const filename = qrImageFile.name || 'qr.png';
      const storagePath = `${Date.now()}_${filename}`;
      const fileBuffer = await qrImageFile.arrayBuffer();

      const { error: uploadError } = await adminClient.storage
        .from('payment-qr-codes')
        .upload(storagePath, fileBuffer, {
          contentType: qrImageFile.type || 'image/png',
          upsert: false,
        });

      if (uploadError) {
        console.error('[POST /api/admin/payment-accounts] Storage upload error:', uploadError.message);
        return Response.json({ error: 'Internal server error' }, { status: 500 });
      }

      // Step 6: Get public URL for the uploaded file
      const { data: publicUrlData } = adminClient.storage
        .from('payment-qr-codes')
        .getPublicUrl(storagePath);

      qrImageUrl = publicUrlData.publicUrl;
    }

    // Step 7: Insert row into payment_accounts
    // Validates: Requirements 25.4, 26.3
    const { data: insertedRow, error: insertError } = await adminClient
      .from('payment_accounts')
      .insert({
        account_holder: textValues.account_holder,
        bank_name: textValues.bank_name,
        account_no: textValues.account_no,
        ifsc: textValues.ifsc,
        upi_id: textValues.upi_id,
        qr_image_url: qrImageUrl,
        created_by: callerUser.id,
      })
      .select()
      .single();

    if (insertError) {
      console.error('[POST /api/admin/payment-accounts] DB insert error:', insertError.message);
      return Response.json({ error: 'Internal server error' }, { status: 500 });
    }

    // Validates: Requirements 26.3
    return Response.json(insertedRow, { status: 201 });
  } catch {
    return Response.json({ error: 'Internal server error' }, { status: 500 });
  }
}

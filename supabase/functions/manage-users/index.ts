// Supabase Edge Function: manage-users
// Handles user CRUD with admin privileges (service_role key)
// Deploy: cd "Business Plan OS" && supabase functions deploy manage-users --no-verify-jwt
// Secret: SUPABASE_SERVICE_ROLE_KEY must be set in Supabase secrets

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.0"

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') || '';
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });

    // Verify the caller is an admin
    const authHeader = req.headers.get('Authorization') || '';
    const token = authHeader.replace('Bearer ', '');

    // Get the calling user's profile to verify admin access
    const { data: { user: caller }, error: callerErr } = await supabase.auth.getUser(token);
    if (callerErr || !caller) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { data: callerProfile } = await supabase
      .from('profiles')
      .select('role')
      .eq('id', caller.id)
      .single();

    const isAdmin = callerProfile?.role === 'superadmin' || callerProfile?.role === 'admin';

    const body = await req.json();
    const { action } = body;

    // ── LIST USERS ──
    if (action === 'list') {
      if (!isAdmin) {
        return new Response(JSON.stringify({ error: 'Admin access required' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      const { data: profiles, error } = await supabase
        .from('profiles')
        .select('*')
        .order('created_at', { ascending: true });

      if (error) throw error;
      return new Response(JSON.stringify({ data: profiles }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── GET OWN PROFILE ──
    if (action === 'me') {
      const { data: profile, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', caller.id)
        .single();

      if (error) throw error;
      return new Response(JSON.stringify({ data: profile }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── ACTIVATE OWN PROFILE (first login password set) ──
    if (action === 'activate') {
      const { data: profile, error } = await supabase
        .from('profiles')
        .update({ status: 'active' })
        .eq('id', caller.id)
        .select()
        .single();

      if (error) throw error;

      // Also update the password if provided
      if (body.newPassword && body.newPassword.length >= 6) {
        const { error: pwErr } = await supabase.auth.admin.updateUserById(caller.id, {
          password: body.newPassword,
        });
        if (pwErr) console.warn('Password update failed:', pwErr.message);
      }

      return new Response(JSON.stringify({ data: profile }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── CREATE USER ──
    if (action === 'create') {
      if (!isAdmin) {
        return new Response(JSON.stringify({ error: 'Admin access required' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const { email, password, name, role, properties, avatar_bg } = body;
      if (!email || !password || !name) {
        return new Response(JSON.stringify({ error: 'email, password, and name are required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Prevent non-superadmin from creating superadmin
      if (role === 'superadmin' && callerProfile?.role !== 'superadmin') {
        return new Response(JSON.stringify({ error: 'Only superadmin can create superadmin users' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Create auth user (skip email confirmation)
      const { data: authData, error: authErr } = await supabase.auth.admin.createUser({
        email,
        password,
        email_confirm: true, // auto-confirm so they can log in immediately
      });

      if (authErr) {
        return new Response(JSON.stringify({ error: authErr.message }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const initials = name.split(' ').map((w: string) => w[0] || '').join('').toUpperCase().slice(0, 2);

      // Create profile
      const { data: profile, error: profErr } = await supabase
        .from('profiles')
        .insert({
          id: authData.user.id,
          email: email.toLowerCase(),
          name,
          initials,
          role: role || 'read_only',
          properties: properties || '"all"',
          status: 'invited',
          avatar_bg: avatar_bg || 'linear-gradient(135deg,#3d7fff,#9b7aff)',
        })
        .select()
        .single();

      if (profErr) {
        // Rollback: delete the auth user if profile creation fails
        await supabase.auth.admin.deleteUser(authData.user.id);
        throw profErr;
      }

      return new Response(JSON.stringify({ data: profile }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── UPDATE USER ──
    if (action === 'update') {
      if (!isAdmin) {
        return new Response(JSON.stringify({ error: 'Admin access required' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const { userId, name, role, properties, status, avatar_bg, newPassword } = body;
      if (!userId) {
        return new Response(JSON.stringify({ error: 'userId is required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Check target user's role
      const { data: targetProfile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .single();

      // Prevent non-superadmin from modifying superadmin
      if (targetProfile?.role === 'superadmin' && callerProfile?.role !== 'superadmin') {
        return new Response(JSON.stringify({ error: 'Cannot modify superadmin' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Build update object
      const updates: any = {};
      if (name !== undefined) {
        updates.name = name;
        updates.initials = name.split(' ').map((w: string) => w[0] || '').join('').toUpperCase().slice(0, 2);
      }
      if (role !== undefined) updates.role = role;
      if (properties !== undefined) updates.properties = properties;
      if (status !== undefined) updates.status = status;
      if (avatar_bg !== undefined) updates.avatar_bg = avatar_bg;

      const { data: profile, error } = await supabase
        .from('profiles')
        .update(updates)
        .eq('id', userId)
        .select()
        .single();

      if (error) throw error;

      // Update password if provided
      if (newPassword && newPassword.length >= 6) {
        const { error: pwErr } = await supabase.auth.admin.updateUserById(userId, {
          password: newPassword,
        });
        if (pwErr) console.warn('Password update failed:', pwErr.message);
      }

      return new Response(JSON.stringify({ data: profile }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── DELETE USER ──
    if (action === 'delete') {
      if (!isAdmin) {
        return new Response(JSON.stringify({ error: 'Admin access required' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const { userId } = body;
      if (!userId) {
        return new Response(JSON.stringify({ error: 'userId is required' }), {
          status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Check target user's role
      const { data: targetProfile } = await supabase
        .from('profiles')
        .select('role')
        .eq('id', userId)
        .single();

      if (targetProfile?.role === 'superadmin') {
        return new Response(JSON.stringify({ error: 'Cannot delete superadmin' }), {
          status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      // Delete profile first (cascading), then auth user
      const { error: profErr } = await supabase
        .from('profiles')
        .delete()
        .eq('id', userId);

      if (profErr) throw profErr;

      const { error: authErr } = await supabase.auth.admin.deleteUser(userId);
      if (authErr) console.warn('Auth user deletion failed:', authErr.message);

      return new Response(JSON.stringify({ success: true }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ error: 'Unknown action: ' + action }), {
      status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message || 'Internal error' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});

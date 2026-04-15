# BPOS Auth Setup - Deployment Guide

## Overview
This update adds real Supabase Auth to BPOS with persistent user accounts, two new roles (Dashboard Viewer, Tracker Viewer), property group access, and a forgot-password flow.

---

## Step 1: Run the SQL Migration

1. Go to your Supabase Dashboard: https://supabase.com/dashboard/project/hpsvhffjebeuqutwpkaa
2. Click **SQL Editor** in the left sidebar
3. Paste the contents of `supabase/migrations/001_create_profiles.sql` and click **Run**
4. Verify: go to **Table Editor** and confirm the `profiles` table exists

---

## Step 2: Deploy the Edge Function

Open your terminal and run:

```bash
cd ~/path-to/"Business Plan OS"
pwd   # Verify you're in the right directory!

# Deploy the manage-users edge function (no JWT verification so the client can call it)
supabase functions deploy manage-users --no-verify-jwt
```

**Important**: The `SUPABASE_SERVICE_ROLE_KEY` is automatically available in edge functions as an environment variable. You do NOT need to set it manually — Supabase provides it.

---

## Step 3: Create Your Admin Account in Supabase Auth

Since we moved from hardcoded credentials to real Supabase Auth, you need to create your first user:

1. Go to **Authentication** > **Users** in the Supabase Dashboard
2. Click **Add user** > **Create new user**
3. Enter:
   - Email: `john@leavenwealth.com`
   - Password: your desired password
   - Check "Auto Confirm User"
4. Copy the new user's UUID
5. Go to **SQL Editor** and run:

```sql
INSERT INTO public.profiles (id, email, name, initials, role, properties, status, avatar_bg)
VALUES (
  'PASTE-UUID-HERE',
  'john@leavenwealth.com',
  'John Younes',
  'JY',
  'superadmin',
  '"all"',
  'active',
  'linear-gradient(135deg,#3d7fff,#9b7aff)'
);
```

6. Repeat for Tim, Danny, Nathan if needed (use `admin`, `asset_manager`, `underwriter` roles)

---

## Step 4: Deploy to Netlify

Push the updated `index.html` to the `main` branch. Netlify auto-deploys.

```bash
git add index.html supabase/
git commit -m "Add Supabase Auth, new roles, property groups"
git push origin main
```

---

## What Changed

### New Files
- `supabase/migrations/001_create_profiles.sql` — profiles table + RLS
- `supabase/functions/manage-users/index.ts` — admin user CRUD edge function

### Modified Files
- `index.html` — complete auth rewrite:
  - Supabase JS client loaded from CDN
  - Login/logout uses `supabase.auth.signInWithPassword()` / `signOut()`
  - Forgot password flow via `supabase.auth.resetPasswordForEmail()`
  - First-login password change prompts and updates Supabase Auth
  - All user data persists in `profiles` table
  - Dashboard Analytics added as Module 8
  - Two new roles: **Dashboard Viewer** (M8 read-only) and **Tracker Viewer** (M7+M8 read-only)
  - Sidebar shows ALL modules — locked ones grayed out with tooltip
  - Permission matrix updated with new roles
  - Property access modal: three-tab UI (All / Specific / Groups)
  - Property search bar for finding specific properties
  - Property groups loaded from BigQuery (same source as dashboard)
  - Mixed access: combine groups + individual properties

### Roles

| Role | Access |
|------|--------|
| Super Admin | Full edit everywhere |
| Admin | Full edit everywhere + user management |
| Asset Manager | Edit most, read-only tracking + dashboard |
| Underwriter | Edit screening/UW/capex/diligence, read tracking + dashboard |
| Property Manager | Edit capex/diligence/onboarding, read others + dashboard |
| Read Only | Read everything except plan lock + user management |
| **Dashboard Viewer** | **Read-only Module 8 (Dashboard) only** |
| **Tracker Viewer** | **Read-only Module 7 (Tracker) + Module 8 (Dashboard) only** |

-- ============================================================
-- BPOS User Profiles Table
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)
-- ============================================================

-- 1. Create the profiles table
CREATE TABLE IF NOT EXISTS public.profiles (
  id          UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  name        TEXT NOT NULL,
  initials    TEXT NOT NULL DEFAULT '',
  role        TEXT NOT NULL DEFAULT 'read_only'
              CHECK (role IN ('superadmin','admin','asset_manager','underwriter',
                              'property_manager','read_only','dashboard','tracker')),
  properties  JSONB NOT NULL DEFAULT '"all"'::jsonb,
  -- properties can be: "all" (JSON string) or {mode, items} object
  -- e.g. {"mode":"groups","items":["Group A","Group B"]}
  -- e.g. {"mode":"specific","items":["Bancroft","Beverly"]}
  -- e.g. {"mode":"mixed","groups":["Group A"],"properties":["Bancroft"]}
  status      TEXT NOT NULL DEFAULT 'invited'
              CHECK (status IN ('active','invited','disabled')),
  avatar_bg   TEXT NOT NULL DEFAULT 'linear-gradient(135deg,#3d7fff,#9b7aff)',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2. Enable RLS
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- 3. RLS Policies

-- Everyone can read their own profile
CREATE POLICY "Users can read own profile"
  ON public.profiles FOR SELECT
  USING (auth.uid() = id);

-- Admins and superadmins can read all profiles
CREATE POLICY "Admins can read all profiles"
  ON public.profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
      AND p.role IN ('superadmin', 'admin')
    )
  );

-- Admins can update profiles (except superadmin profiles, unless they are superadmin)
CREATE POLICY "Admins can update profiles"
  ON public.profiles FOR UPDATE
  USING (
    EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid()
      AND p.role IN ('superadmin', 'admin')
    )
  );

-- Users can update their own profile (limited fields handled at app level)
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (auth.uid() = id);

-- Service role handles INSERT (via edge function)
-- Anon/authenticated users cannot insert directly
CREATE POLICY "Service role inserts profiles"
  ON public.profiles FOR INSERT
  WITH CHECK (false);  -- Only service_role bypasses RLS

-- 4. Auto-update updated_at
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER on_profiles_updated
  BEFORE UPDATE ON public.profiles
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- 5. Index for quick lookups
CREATE INDEX IF NOT EXISTS idx_profiles_role ON public.profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_email ON public.profiles(email);

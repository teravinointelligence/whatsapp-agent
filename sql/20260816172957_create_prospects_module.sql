-- Aplicada en el proyecto Supabase teravino-crm el 2026-08-16.
-- Se guarda aquí sólo como referencia de lo que el agente espera encontrar.
--
-- Módulo de prospectos: negocios que contactaron pero aún no son cuentas.
-- El agente de Telegram los captura; la administración los asigna a un
-- vendedor y desde el CRM se convierten en cuenta.
CREATE TABLE public.prospects (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  business_name        text NOT NULL,
  contact_name         text,
  -- Teléfono verificado que el prospecto compartió por Telegram.
  phone                text NOT NULL,
  telegram_user_id     text,
  region               text,
  city                 text,
  -- Qué pidió o en qué mostró interés, en palabras del propio prospecto.
  interest             text,
  notes                text,
  status               text NOT NULL DEFAULT 'nuevo'
                       CHECK (status IN ('nuevo','asignado','convertido','descartado')),
  assigned_rep_id      uuid REFERENCES public.sales_reps(id) ON DELETE SET NULL,
  assigned_at          timestamptz,
  -- Se llena cuando el CRM lo convierte en cuenta, para conservar la trazabilidad.
  converted_account_id uuid REFERENCES public.accounts(id) ON DELETE SET NULL,
  converted_at         timestamptz,
  source               text NOT NULL DEFAULT 'telegram',
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.prospects IS
  'Prospectos captados por el agente de Telegram, pendientes de asignar y convertir en cuenta.';

-- Un teléfono es un prospecto: si vuelve a escribir se actualiza, no se duplica.
CREATE UNIQUE INDEX prospects_phone_key ON public.prospects (phone);
CREATE INDEX prospects_status_idx ON public.prospects (status, created_at DESC);
CREATE INDEX prospects_assigned_rep_idx ON public.prospects (assigned_rep_id);

ALTER TABLE public.prospects ENABLE ROW LEVEL SECURITY;

-- Mismo criterio que accounts: la administración ve todo, el vendedor ve los suyos.
CREATE POLICY prospects_select ON public.prospects
  FOR SELECT USING (is_admin() OR assigned_rep_id = current_rep_id());

CREATE POLICY prospects_finance_read ON public.prospects
  FOR SELECT USING (can_read_all());

CREATE POLICY prospects_insert ON public.prospects
  FOR INSERT WITH CHECK (is_admin() OR assigned_rep_id = current_rep_id());

CREATE POLICY prospects_update ON public.prospects
  FOR UPDATE USING (is_admin() OR assigned_rep_id = current_rep_id())
  WITH CHECK (is_admin() OR assigned_rep_id = current_rep_id());

CREATE POLICY prospects_delete ON public.prospects
  FOR DELETE USING (is_admin());

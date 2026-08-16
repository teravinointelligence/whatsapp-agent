-- Aplicada en el proyecto Supabase teravino-crm el 2026-08-16.
--
-- Correo del prospecto: es a donde se le mandará la factura cuando se
-- convierta en cuenta, así que conviene pedirlo desde el primer contacto.
ALTER TABLE public.prospects ADD COLUMN email text;

COMMENT ON COLUMN public.prospects.email IS
  'Correo para envío de cotizaciones y facturas. Se pide al captar el prospecto.';

-- Enable Realtime publication for positions, orders, and profiles
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'positions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.positions;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'orders'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.orders;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables 
    WHERE pubname = 'supabase_realtime' AND tablename = 'profiles'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.profiles;
  END IF;
END $$;

-- Ensure RLS SELECT policies for user subscriptions over realtime WebSockets
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'positions' AND policyname = 'Users can select their own positions'
  ) THEN
    CREATE POLICY "Users can select their own positions"
      ON public.positions FOR SELECT
      USING (auth.uid() = user_id);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'orders' AND policyname = 'Users can select their own orders'
  ) THEN
    CREATE POLICY "Users can select their own orders"
      ON public.orders FOR SELECT
      USING (auth.uid() = user_id);
  END IF;
END $$;

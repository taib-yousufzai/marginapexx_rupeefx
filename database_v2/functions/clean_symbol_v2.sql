-- ==============================================================================
-- DATABASE v2: clean_symbol_v2
-- Deterministic Canonical Symbol Normalizer for DB queries, triggers, and RPCs
-- ==============================================================================
CREATE OR REPLACE FUNCTION public.clean_symbol_v2(p_sym text)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    v_clean text;
BEGIN
    IF p_sym IS NULL OR p_sym = '' THEN
        RETURN '';
    END IF;

    -- 1. Strip exchange prefixes
    v_clean := regexp_replace(p_sym, '^(CRYPTO:|NSE:|NFO:|MCX:|BSE:|BFO:|US:|FOREX:|COMEX:|BINANCE:)', '', 'i');
    
    -- 2. Strip slashes, spaces, underscores, hyphens, and perp/futures tags
    v_clean := regexp_replace(v_clean, '[\/\s\_\-]', '', 'g');
    v_clean := regexp_replace(v_clean, '(PERP|\.P|FUT)$', '', 'i');
    v_clean := UPPER(v_clean);

    -- 3. Commodity canonical normalization
    IF v_clean IN ('XAUUSD', 'GC=F', 'GC', 'GOLD') THEN
        RETURN 'XAUUSD';
    ELSIF v_clean IN ('XAGUSD', 'SI=F', 'SI', 'SILVER') THEN
        RETURN 'XAGUSD';
    ELSIF v_clean IN ('XTIUSD', 'CL=F', 'CL', 'WTI', 'CRUDE', 'CRUDEOIL') THEN
        RETURN 'XTIUSD';
    ELSIF v_clean IN ('XCUUSD', 'HG=F', 'HG', 'COPPER') THEN
        RETURN 'XCUUSD';
    ELSIF v_clean IN ('XNGUSD', 'NG=F', 'NG', 'NATGAS', 'NATURALGAS') THEN
        RETURN 'XNGUSD';
    END IF;

    -- 4. Doge typo normalization
    IF v_clean IN ('DODGE', 'DODGEUSDT', 'DOGE', 'DOGEUSDT') THEN
        RETURN 'DOGEUSDT';
    END IF;

    -- 5. Standard crypto USDT normalization
    IF v_clean ~ '^(BTC|ETH|DOGE|SOL|XRP|ADA|BNB|DOT|LTC|AVAX|MATIC|LINK|UNI|BCH|SHIB|PEPE|TRX|NEAR|SUI|APT|FET|RNDR|INJ|TIA|OP|ARB)$' THEN
        RETURN v_clean || 'USDT';
    END IF;

    IF v_clean ~ 'USDT$' THEN
        RETURN v_clean;
    END IF;

    IF v_clean ~ 'USD$' AND NOT (v_clean IN ('GBPUSD', 'EURUSD', 'AUDUSD', 'NZDUSD', 'USDCAD', 'USDJPY', 'USDCHF')) THEN
        RETURN regexp_replace(v_clean, 'USD$', 'USDT');
    END IF;

    RETURN v_clean;
END;
$$;

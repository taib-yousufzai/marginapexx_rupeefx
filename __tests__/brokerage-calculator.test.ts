import { describe, it, expect } from 'vitest';
import { calculateOrderBrokerage, calculateCarryBrokerage } from '../lib/trading/BrokerageCalculator';

describe('BrokerageCalculator Additive Tests', () => {
  const dummySegSetting = {
    commission_type: 'Per Crore',
    commission_value: 1000, // 1000 per crore = 0.01%
    intraday_commission_type: 'Per Crore',
    intraday_commission_value: 1000,
    carry_commission_type: 'Per Crore',
    carry_commission_value: 500, // 500 per crore = 0.005%
    gtt_commission_type: 'Per Trade',
    gtt_commission_value: 20,
  };

  it('calculates INTRADAY brokerage as (entry + exit) legs', () => {
    // exposure = 1,00,00,000 (1 crore)
    // intraday single leg = 1,000
    // intraday total (x2) = 2,000
    const res = calculateOrderBrokerage({
      exposure: 10000000,
      lots: 1,
      productType: 'INTRADAY',
      orderType: 'LIMIT',
      isExit: false,
      segSetting: dummySegSetting,
      dbSegment: 'NSE_EQ',
    });

    expect(res.intradayCharge).toBe(2000);
    expect(res.carryCharge).toBe(0);
    expect(res.gttCharge).toBe(0);
    expect(res.totalBrokerage).toBe(2000);
  });

  it('calculates CARRY brokerage additively as Intraday + Carry', () => {
    // exposure = 1,00,00,000 (1 crore)
    // intraday single leg = 1,000 -> x2 = 2,000
    // carry single leg = 500 -> x2 = 1,000
    // total = 3,000
    const res = calculateOrderBrokerage({
      exposure: 10000000,
      lots: 1,
      productType: 'CARRY',
      orderType: 'LIMIT',
      isExit: false,
      segSetting: dummySegSetting,
      dbSegment: 'NSE_EQ',
    });

    expect(res.intradayCharge).toBe(2000);
    expect(res.carryCharge).toBe(1000);
    expect(res.gttCharge).toBe(0);
    expect(res.totalBrokerage).toBe(3000);
  });

  it('calculates GTT brokerage additively as Intraday + Carry + GTT flat charge', () => {
    // exposure = 1,00,00,000 (1 crore)
    // intraday single leg = 1,000 -> x2 = 2,000
    // carry single leg = 500 -> x2 = 1,000
    // gtt charge = 20
    // total = 3,020
    const res = calculateOrderBrokerage({
      exposure: 10000000,
      lots: 1,
      productType: 'CARRY',
      orderType: 'GTT',
      isExit: false,
      segSetting: dummySegSetting,
      dbSegment: 'NSE_EQ',
    });

    expect(res.intradayCharge).toBe(2000);
    expect(res.carryCharge).toBe(1000);
    expect(res.gttCharge).toBe(20);
    expect(res.totalBrokerage).toBe(3020);
  });

  it('returns 0 for exit orders as fees are collected upfront', () => {
    const res = calculateOrderBrokerage({
      exposure: 10000000,
      lots: 1,
      productType: 'CARRY',
      orderType: 'GTT',
      isExit: true,
      segSetting: dummySegSetting,
      dbSegment: 'NSE_EQ',
    });

    expect(res.totalBrokerage).toBe(0);
  });

  it('honors use_custom_calc for CRYPTO segment', () => {
    const cryptoSegSetting = {
      ...dummySegSetting,
      use_custom_calc: true,
    };

    const res = calculateOrderBrokerage({
      exposure: 10000000,
      lots: 1,
      productType: 'INTRADAY',
      orderType: 'MARKET',
      isExit: false,
      segSetting: cryptoSegSetting,
      dbSegment: 'CRYPTO',
    });

    expect(res.totalBrokerage).toBe(0);
  });
});

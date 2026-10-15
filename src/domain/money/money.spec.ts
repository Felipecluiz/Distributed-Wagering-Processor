import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError, Money } from "./money";

const brl = (amount: string) => Money.from({ amount, currency: "BRL" });

describe("Money.from", () => {
  test("aceita exatamente 2 casas", () => {
    expect(brl("25.00").toString()).toBe("25.00");
    expect(brl("25.50").toString()).toBe("25.50");
    expect(brl("0.01").toString()).toBe("0.01");
  });

  test.each([
    "",
    " ",
    "NaN",
    "Infinity",
    "1e3",
    "1E3",
    "-1.00",
    "+1.00",
    "25",
    "25.5",
    "1.234",
    "1,00",
    ".50",
    "1.",
    "abc",
  ])("rejeita entrada inválida %p", (amount) => {
    expect(() => brl(amount)).toThrow(InvalidMoneyError);
  });

  test("rejeita amount que não é string", () => {
    expect(() =>
      Money.from({ amount: 25 as unknown as string, currency: "BRL" }),
    ).toThrow(InvalidMoneyError);
  });

  test.each(["", "br", "brl", "BRLL"])(
    "rejeita moeda inválida %p",
    (currency) => {
      expect(() => Money.from({ amount: "1.00", currency })).toThrow(
        InvalidMoneyError,
      );
    },
  );
});

describe("Money aritmética", () => {
  test("é exata onde float falharia (0.10 + 0.20)", () => {
    expect(brl("0.10").add(brl("0.20")).toString()).toBe("0.30");
  });

  test("subtract pode resultar negativo; negate inverte", () => {
    const r = brl("10.00").subtract(brl("10.01"));
    expect(r.isNegative()).toBe(true);
    expect(r.toString()).toBe("-0.01");
    expect(r.negate().toString()).toBe("0.01");
  });

  test("é imutável", () => {
    const a = brl("1.00");
    a.add(brl("2.00"));
    expect(a.toString()).toBe("1.00");
  });

  test("valores grandes sem perda de precisão", () => {
    expect(brl("999999999999999999.99").add(brl("0.01")).toString()).toBe(
      "1000000000000000000.00",
    );
  });
});

describe("Money consultas", () => {
  test("zero / positive / negative / lessThan / equals", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    expect(brl("0.01").isPositive()).toBe(true);
    expect(brl("1.00").isLessThan(brl("1.01"))).toBe(true);
    expect(brl("1.00").equals(brl("1.00"))).toBe(true);
  });

  test("toJSON usa string decimal", () => {
    expect(JSON.stringify(brl("25.00"))).toBe(
      '{"amount":"25.00","currency":"BRL"}',
    );
  });

  test("fromPersisted aceita negativos", () => {
    expect(Money.fromPersisted("-5.50", "BRL").toString()).toBe("-5.50");
  });
});

describe("Money conflito de moeda", () => {
  const usd = Money.from({ amount: "1.00", currency: "USD" });
  test("add / subtract / isLessThan lançam erro de domínio", () => {
    expect(() => brl("1.00").add(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").subtract(usd)).toThrow(CurrencyMismatchError);
    expect(() => brl("1.00").isLessThan(usd)).toThrow(CurrencyMismatchError);
  });
  test("equals entre moedas diferentes é false, sem lançar", () => {
    expect(brl("1.00").equals(usd)).toBe(false);
  });
});

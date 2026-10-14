export interface MoneyProps {
  amount: string; // decimal string, ex.: "25.00"
  currency: string; // ISO-4217
}

export class InvalidMoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidMoneyError";
  }
}

export class CurrencyMismatchError extends Error {
  constructor(a: string, b: string) {
    super(`Currency mismatch: ${a} vs ${b}`);
    this.name = "CurrencyMismatchError";
  }
}

// Exige exatamente 2 casas decimais. Sem sinal, sem expoente, sem espaços.
const INPUT_PATTERN = /^(\d+)\.(\d{2})$/;
// Formato do valor persistido/serializado, permite sinal (saldo/diferença podem ser negativos).
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

export class Money {
  private constructor(
    private readonly cents: bigint,
    public readonly currency: string,
  ) {}

  /** Contrato de entrada: rejeita negativos, NaN, Infinity, notação científica, vazio e >2 casas. */
  static from(props: MoneyProps): Money {
    if (typeof props?.amount !== "string") {
      throw new InvalidMoneyError("amount must be a decimal string");
    }
    Money.assertCurrency(props.currency);
    const match = INPUT_PATTERN.exec(props.amount);
    if (!match) {
      throw new InvalidMoneyError(
        `Invalid amount: "${props.amount}" (expected decimal string with exactly 2 decimal places)`,
      );
    }
    const [, whole, frac] = match;
    const cents = BigInt(whole!) * 100n + BigInt(frac!);
    return new Money(cents, props.currency);
  }

  /** Reidratação do banco (numeric(20,2) como string). Aceita sinal negativo. */
  static fromPersisted(amount: string, currency: string): Money {
    Money.assertCurrency(currency);
    const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount);
    if (!match)
      throw new InvalidMoneyError(`Invalid persisted amount: "${amount}"`);
    const [, sign, whole, frac = ""] = match;
    const abs = BigInt(whole!) * 100n + BigInt(frac.padEnd(2, "0"));
    return new Money(sign === "-" ? -abs : abs, currency);
  }

  static zero(currency: string): Money {
    Money.assertCurrency(currency);
    return new Money(0n, currency);
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents + other.cents, this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.cents - other.cents, this.currency);
  }

  negate(): Money {
    return new Money(-this.cents, this.currency);
  }

  isZero(): boolean {
    return this.cents === 0n;
  }
  isPositive(): boolean {
    return this.cents > 0n;
  }
  isNegative(): boolean {
    return this.cents < 0n;
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.cents < other.cents;
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.cents === other.cents;
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  /** Sempre com 2 casas: "25.00", "-0.05". */
  toString(): string {
    const negative = this.cents < 0n;
    const abs = negative ? -this.cents : this.cents;
    const whole = abs / 100n;
    const frac = (abs % 100n).toString().padStart(2, "0");
    return `${negative ? "-" : ""}${whole}.${frac}`;
  }

  private static assertCurrency(currency: string): void {
    if (typeof currency !== "string" || !CURRENCY_PATTERN.test(currency)) {
      throw new InvalidMoneyError(`Invalid currency: "${currency}"`);
    }
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(this.currency, other.currency);
    }
  }
}

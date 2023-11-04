import {Duration} from 'luxon';
import VError from 'verror';

// Max length for free-form description text fields such as issue body
const MAX_TEXT_LENGTH = 1000;

export class Utils {
  static urlWithoutTrailingSlashes(url: string): string {
    return new URL(url).toString().replace(/\/{1,10}$/, '');
  }

  static parseInteger(value: string): number {
    const parsedValue = parseInt(value, 10);
    if (isNaN(parsedValue) || isNaN(Number(value))) {
      throw new VError('Invalid integer: %s', value);
    }
    return parsedValue;
  }

  static parseIntegerPositive(value: string): number {
    const parsedValue = Utils.parseInteger(value);
    if (parsedValue <= 0) {
      throw new VError('Not positive: %s', value);
    }
    return parsedValue;
  }

  static parseIntegerWithDefault(
    // eslint-disable-next-line max-len
    // eslint-disable-next-line @typescript-eslint/explicit-module-boundary-types
    value: any,
    defaultValue: number,
    toPositive?: boolean
  ): number {
    if (!value) {
      return defaultValue;
    }
    if (typeof value === 'number') {
      return value;
    }
    if (typeof value === 'string') {
      if (toPositive) {
        return Utils.parseIntegerPositive(value);
      }
      return Utils.parseInteger(value);
    }
    throw new VError('Invalid integer: %s', value);
  }

  static parseFloatFixedPoint(value: string, fractionDigits?: number): number {
    const parsedValue = parseFloat(value);
    if (isNaN(parsedValue) || isNaN(Number(value))) {
      throw new VError('Invalid float: %s', value);
    }
    return fractionDigits !== undefined && fractionDigits !== null
      ? parseFloat(parsedValue.toFixed(fractionDigits))
      : parsedValue;
  }

  static parseFloatFixedPointPositive(
    value: string,
    fractionDigits?: number
  ): number {
    const parsedValue = Utils.parseFloatFixedPoint(value, fractionDigits);
    if (parsedValue <= 0) {
      throw new VError('Not positive float: %s', value);
    }
    return parsedValue;
  }

  static toStringList(value?: string | string[]): string[] {
    if (!value) {
      return [];
    }
    if (Array.isArray(value)) {
      return value;
    }
    return value
      .split(',')
      .map((x) => x.trim())
      .filter((p) => p);
  }

  static toDate(val: Date | string | number | undefined): Date | undefined {
    if (typeof val === 'number') {
      return new Date(val);
    }
    if (!val) {
      return undefined;
    }
    return new Date(val);
  }

  /**
   * Parses a string into a duration. The string must either be a number (e.g.
   * '123', '1000') which will be interpreted as milliseconds, or a number
   * suffixed by a common unit (e.g. '10 seconds', '1 minute', '2 hours').
   */
  static toDuration(val: number | string): Duration {
    if (typeof val == 'number') {
      return Duration.fromMillis(val);
    }
    const parts = val.split(' ').filter((s) => s);
    if (!parts.length || parts.length > 2 || !/^[0-9]+$/.test(parts[0])) {
      throw new VError('invalid duration string: %j', val);
    }
    const num = parseInt(parts[0], 10);
    let unit = parts.length === 1 ? 'milliseconds' : parts[1];
    if (!unit.endsWith('s')) {
      unit += 's';
    }
    return Duration.fromObject({[unit]: num});
  }

  static sleep(millis: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, millis);
    });
  }

static toCategoryDetail<EnumType extends {Custom: any}>(
    enumObject: EnumType & Record<string, any>,
    category: string,
    categoryMapping: Record<string, string> = {}
  ): {
    category: EnumType[keyof EnumType];
    detail: string;
  } {
    const enumSymbol =
      enumObject[category] ?? enumObject[categoryMapping[category]];
    if (enumSymbol) {
      return {
        category: enumSymbol,
        detail: category,
      };
    }

    return {
      category: enumObject.Custom,
      detail: category,
    };
  }

  static cleanAndTruncate(str?: string, maxLength?: number): string | null | undefined {
    if (!str) {
      return str;
    }
    const length = maxLength ?? MAX_TEXT_LENGTH;
    let result: string;
    if (str.length <= length) {
      result = str;
    } else {
      // If the last character is part of a unicode surrogate pair, include the next character
      const lastChar = str.codePointAt(length - 1) ?? 0;
      result = lastChar > 65535 ? str.substring(0, length + 1) : str.substring(0, length);
    }
    // eslint-disable-next-line no-control-regex
    return result.replace(/\u0000/g, '');
  }
}

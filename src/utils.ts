export class Utils {
  static urlWithoutTrailingSlashes(url: string): string {
    return new URL(url).toString().replace(/\/{1,10}$/, '');
  }
}

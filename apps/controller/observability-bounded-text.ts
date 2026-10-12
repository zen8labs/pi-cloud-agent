const MAX_CONTENT = 32_000;

export class BoundedText {
  private text = "";

  append(value: string): void {
    if (this.text.length >= MAX_CONTENT) return;
    this.text += value.slice(0, MAX_CONTENT - this.text.length);
  }

  value(): string {
    return this.text;
  }
}

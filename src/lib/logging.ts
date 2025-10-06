export function logError(...input: unknown[]): void {
  if (input.length === 0) return;
  const last = input[input.length - 1];
  const rest = input.slice(0, -1);
  if (last instanceof Error) {
    const pieces: string[] = [];
    if (typeof last.message === 'string' && last.message.length > 0) {
      pieces.push(last.message);
    }
    const stack = typeof last.stack === 'string' && last.stack.length > 0 ? last.stack : last.message;
    if (stack && (!pieces.length || pieces[0] !== stack)) {
      pieces.push(stack);
    }
    const payload = pieces.join('\n');
    if (rest.length > 0) {
      console.error(...rest, payload);
    } else {
      console.error(payload);
    }
    return;
  }
  console.error(...input);
}

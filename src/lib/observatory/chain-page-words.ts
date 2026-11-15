export function chainHeldLines(input: {
  settled: number;
  delivered: number;
  inconclusiveSettled: number;
}): string[] {
  const lines: string[] = [];
  if (input.inconclusiveSettled > 0) {
    lines.push(
      "Held counts settled purchases whose paid request then got an HTTP status from 400 to 499. vet402 holds these rather than counting them against the seller, because a 4xx can come from a request vet402 formed wrongly. They are left out of the Delivered denominator.",
    );
    const other = input.settled - input.delivered - input.inconclusiveSettled;
    if (other > 0) {
      lines.push(
        `The other ${other} settled purchases that are not delivered got a 5xx, a 202 Accepted, an empty body, or no HTTP status on record.`,
      );
    }
    lines.push("The methodology gives the rule.");
  }
  return lines;
}
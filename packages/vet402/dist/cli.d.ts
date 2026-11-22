#!/usr/bin/env node
import { type CheckResult } from "./check.js";
export declare function exitCodeOf(r: CheckResult): number;
export declare function render(url: string, r: CheckResult): string;
export declare function main(argv: string[], out?: NodeJS.WriteStream & {
    fd: 1;
}, err?: NodeJS.WriteStream & {
    fd: 2;
}): Promise<number>;

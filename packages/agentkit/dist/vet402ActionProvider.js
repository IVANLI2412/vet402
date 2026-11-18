var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
import "reflect-metadata";
import { z } from "zod";
import { ActionProvider } from "@coinbase/agentkit";
import { CreateAction } from "@coinbase/agentkit";
import { Vet402PayInputSchema } from "./schemas.js";
import { executeVet402Pay } from "./pay-tool-core.js";
export class Vet402ActionProvider extends ActionProvider {
    config;
    constructor(config) {
        super("vet402", []);
        this.config = config;
        this.supportsNetwork = () => true;
    }
    async vet402Pay(args) {
        const result = await executeVet402Pay(args, this.config);
        return JSON.stringify(result);
    }
    supportsNetwork;
}
__decorate([
    CreateAction({
        name: "vet402_pay",
        description: "Check an x402 seller with vet402, then pay only when the verdict is ALLOW. " +
            "Returns status, recommendation, reason codes, tx hash and the seller body. " +
            "Never pass account, maxUsd, allowWarn or allowUnknown in the arguments.",
        schema: Vet402PayInputSchema,
    }),
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [void 0]),
    __metadata("design:returntype", Promise)
], Vet402ActionProvider.prototype, "vet402Pay", null);
export function vet402ActionProvider(options) {
    return new Vet402ActionProvider(options);
}

import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import type { ProviderIdentityPort, ProviderPrincipal } from "../application/provider-identity";
import { TOKENS } from "./tokens";

const IS_PUBLIC = "isPublic";
/** Rotas abertas mesmo com autenticação ligada (health checks). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export type AuthenticatedRequest = Request & { principal?: ProviderPrincipal };

/**
 * Guard global. Hoje delega a um ProviderIdentityPort que aceita todos (autenticação fora do
 * escopo, ver ARCHITECTURE.md seção 12). Trocar a implementação do port liga a autenticação
 * sem tocar em controllers nem use cases.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TOKENS.providerIdentity) private readonly identity: ProviderIdentityPort,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    if (isPublic) return true;
    const req = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    req.principal = await this.identity.authenticate(req.headers);
    return true;
  }
}

/**
 * Ponto de extensão da autenticação (ver ARCHITECTURE.md, seção 12).
 *
 * Desenho alvo: um IdP externo (Keycloak/OIDC) emite tokens para cada provedor; a
 * implementação valida o JWT via JWKS e mapeia o `client_id` ao `providerId` autorizado.
 * O use case então exige que o `providerId` do payload seja o do token, impedindo um
 * provedor de submeter transações como outro.
 */
export interface ProviderPrincipal {
  /** undefined = sem autenticação configurada (modo atual). */
  providerId?: string;
}

export interface ProviderIdentityPort {
  /** Resolve o chamador a partir dos headers. Lança se o token for inválido. */
  authenticate(headers: Record<string, string | string[] | undefined>): Promise<ProviderPrincipal>;
}

/** Implementação atual: autenticação desligada, todo chamador é aceito. */
export class NoAuthProviderIdentity implements ProviderIdentityPort {
  async authenticate(): Promise<ProviderPrincipal> {
    return {};
  }
}

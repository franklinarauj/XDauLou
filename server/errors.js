// Erros conhecidos da aplicação, com mensagens amigáveis em português.

export const ERRORS = {
  INVALID_URL: [400, 'Esse link não é de um post do X. Copie o link pelo botão Compartilhar do post.'],
  NOT_FOUND: [404, 'Não encontramos esse post. Ele pode ter sido apagado.'],
  PRIVATE: [403, 'Este post pertence a uma conta privada.'],
  SENSITIVE: [403, 'O X só mostra este post para quem está logado, por ter conteúdo sensível.'],
  UNAVAILABLE: [410, 'Este post não está disponível.'],
  NO_MEDIA: [404, 'Nenhuma mídia encontrada neste link.'],
  ONLY_PHOTOS: [404, 'Este post só tem imagens. O XDauLou baixa vídeos e GIFs.'],
  RATE_LIMITED: [429, 'Muitas tentativas seguidas. Espere um minuto e tente de novo.'],
  UPSTREAM_RATE_LIMITED: [503, 'O X está limitando as consultas agora. Tente de novo em alguns minutos.'],
  UPSTREAM_ERROR: [502, 'Não conseguimos falar com o X agora. Tente de novo em instantes.'],
  MEDIA_NOT_ALLOWED: [400, 'Endereço de mídia inválido.'],
  LINK_EXPIRED: [410, 'Este link de download expirou. Busque o post de novo.'],
  MEDIA_TOO_LARGE: [413, 'O arquivo é grande demais para converter em GIF. Baixe em MP4.'],
  GIF_BUSY: [503, 'Há muitas conversões em andamento. Tente de novo em alguns segundos.'],
  GIF_UNAVAILABLE: [501, 'A conversão para GIF não está disponível neste servidor.'],
  GIF_FAILED: [500, 'Não foi possível converter este vídeo em GIF. Baixe em MP4.'],
  NOT_FOUND_ROUTE: [404, 'Página não encontrada.'],
  INTERNAL: [500, 'Algo deu errado do nosso lado. Tente de novo.'],
};

export class AppError extends Error {
  /**
   * @param {keyof typeof ERRORS} code
   * @param {{cause?: unknown, retryAfter?: number}} [opts]
   */
  constructor(code, opts = {}) {
    const [status, message] = ERRORS[code] ?? ERRORS.INTERNAL;
    super(message, { cause: opts.cause });
    this.code = ERRORS[code] ? code : 'INTERNAL';
    this.status = status;
    this.retryAfter = opts.retryAfter;
  }

  toJSON() {
    return { error: { code: this.code, message: this.message } };
  }
}

export const isAppError = (err) => err instanceof AppError;

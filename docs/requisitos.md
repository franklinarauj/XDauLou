# Requisitos do Projeto: Downloader de Vídeos e GIFs do X (Twitter)

Documento de especificação de requisitos focado em uma aplicação elegante, simples, funcional e com fricção zero para o usuário final.

---

## 1. Requisitos Funcionais (O que o app faz)

* **Input Único Inteligente:** Um campo de texto centralizado que aceita a URL do post (suportando os domínios `x.com` e `twitter.com`, com ou sem parâmetros de rastreamento como `?s=20`).
* **Auto-detecção e Colagem Rápida:** Botão de "Colar" (*Paste*) integrado ao input e disparo automático da busca assim que um link válido for inserido.
* **Pré-visualização (Preview):** Exibição da miniatura (*thumbnail*) do vídeo ou GIF, duração e nome/arroba do autor antes do download para confirmar a mídia.
* **Seleção de Qualidade:** Opções claras de resolução disponíveis nos metadados (ex: `1080p`, `720p`, `480p`), exibindo o tamanho estimado do arquivo em MB.
* **Conversão Real de GIF:** Como o X armazena GIFs internamente como vídeos `.mp4` em loop, o sistema deve oferecer a opção de baixar tanto no formato original (MP4 leve) quanto convertido para `.gif` real.
* **Download Direto:** Ao clicar em baixar, o arquivo deve ser salvo imediatamente no dispositivo sem abrir novas abas ou players externos.

---

## 2. Requisitos de Interface e Experiência (UX/UI)

* **Design Minimalista (Single-Page):** Uma única tela limpa, sem poluição visual, pop-ups invasivos ou redirecionamentos confusos.
* **Feedback Visual Claro:** Indicadores de carregamento (*skeletons* ou *spinners* suaves) durante a extração e mensagens de erro amigáveis (ex: *"Este post pertence a uma conta privada"* ou *"Nenhuma mídia encontrada neste link"*).
* **Responsividade Total (Mobile-First):** Layout perfeitamente adaptado para dispositivos móveis, considerando que a maior parte do compartilhamento de links do X ocorre via smartphone.
* **Tema Escuro/Claro (Dark Mode):** Suporte automático à preferência do sistema operacional do usuário, harmonizando com a estética nativa do X.

---

## 3. Requisitos Técnicos e Não-Funcionais (Bastidores)

* **Backend Extrator Robusto:** Um serviço leve (Node.js, Python ou Go) capaz de consultar os endpoints públicos/GraphQL do X ou utilizar ferramentas consolidadas (como `yt-dlp`) para extrair a URL direta do arquivo `.mp4`.
* **Proxy de Stream (Bypass de CORS):** O servidor deve atuar como intermediário no fluxo de download ou forçar o cabeçalho `Content-Disposition: attachment` para garantir que o navegador baixe o arquivo em vez de apenas reproduzi-lo.
* **Cache Temporário:** Armazenar em memória (ex: Redis) os metadados das URLs buscadas recentemente por alguns minutos para evitar requisições duplicadas ao X e acelerar o tempo de resposta.
* **Rate Limiting (Proteção):** Limitar o número de requisições por IP para evitar abusos e bloqueios por parte dos servidores do X.
* **Privacidade (Zero Logs):** Não exigir autenticação/login e não armazenar histórico de downloads ou links pesquisados pelos usuários.
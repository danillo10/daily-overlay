# Daily Overlay

Overlay Electron para dailies: legendas ao vivo por cima da tela da reunião, sem bloquear o mouse.

## O que faz

- Janela transparente sempre no topo, na parte de baixo do monitor
- Segue o monitor onde o cursor está (a tela ativa da daily)
- Transcreve microfone e/ou áudio da reunião (loopback)
- Clique atravessa o overlay para você continuar na call
- Atalho global **Ctrl+Shift+D** inicia e pausa
- **Ctrl+Shift+O** mostra/oculta o overlay
- **Ctrl+Shift+L** liga/desliga click-through
- Copia a ata no final

## Como rodar

```bash
npm install
npm run dev
```

Na primeira vez com Whisper local, o modelo `whisper-tiny` (~75 MB) é baixado e fica em cache.

## Captura de áudio

1. **Reunião + microfone** — mistura o que sai no sistema com a sua voz
2. **Só áudio da reunião** — usa loopback da tela (PipeWire/portal no Linux)
3. **Só microfone** — Web Speech para legendas quase instantâneas

No Linux, aceite o portal de captura de tela quando o Electron pedir. Isso é necessário para pegar o áudio da call (Meet, Zoom, Teams, etc.).

## Motores

- **Auto** — Web Speech no microfone; Whisper local se houver áudio do sistema
- **Web Speech** — legendas rápidas, só mic
- **Whisper local** — funciona offline depois do download, mic + reunião
- **Whisper na nuvem** — Groq ou OpenAI, mais preciso (API key opcional)

## Notas de overlay no Linux

Always-on-top e click-through dependem do compositor. X11, GNOME e KDE recentes costumam respeitar. Se o overlay não ficar acima de uma janela em tela cheia, tire o full screen da call ou escolha o monitor certo no painel.

O Electron de desenvolvimento usa `--no-sandbox` porque o `chrome-sandbox` do npm não vem com bit setuid. Isso vale só para `npm start` / `npm run dev`.

## Android (Java)

O app nativo está em [`android/`](android/README.md). Abre essa pasta no Android Studio, sincroniza o Gradle e roda no celular.

No Android a transcrição ao vivo usa o **microfone** (o sistema não entrega o áudio interno da call para um app comum). YouTube gera **SRT** em Downloads; a queima da legenda no MP4 fica no app do PC.

## PolyCall Web

A aplicação web de reuniões multilíngues está em [`src/web/`](src/web/). Ela inclui:

- criação e entrada em salas por link;
- áudio e vídeo ponto a ponto com WebRTC;
- lista de participantes e controles de câmera/microfone;
- reconhecimento de fala, legendas traduzidas e leitura no idioma escolhido;
- cobrança individual: cada participante informa sua própria chave OpenAI;
- chave mantida apenas na sessão do navegador e encaminhada por HTTPS, sem persistência no servidor.

### Desenvolvimento

```bash
cp .env.example .env
npm run web:dev
```

Abra `http://localhost:5173/web/`. Para testar uma reunião, use duas abas ou dispositivos e entre pelo mesmo código.

### Produção

```bash
npm run build
npm run web:start
```

O servidor fica em `http://localhost:3000`. Os modelos econômicos usados são `gpt-4o-mini-transcribe`, `gpt-4.1-nano` e `tts-1`. Cada participante paga a própria transcrição e, ao ouvir outro idioma, sua própria tradução e voz.

Para deploy separado:

- Railway: backend Socket.IO e proxy OpenAI, configurado por `railway.toml`;
- Vercel: frontend estático, configurado por `vercel.json`;
- defina `VITE_API_URL` no Vercel com a URL pública do Railway;
- defina `CLIENT_ORIGINS` no Railway com a URL pública do Vercel.

Em produção, use HTTPS e configure `ICE_SERVERS_JSON` com um serviço TURN.

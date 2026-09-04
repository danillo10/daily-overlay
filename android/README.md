# Daily Overlay para Android (Java)

App nativo em Java com overlay de legendas, Whisper na nuvem e tradução PT. Fica na pasta `android/` do mesmo repositório.

## O que roda no celular

- Transcrição ao vivo do **microfone** (OpenAI Whisper ou Groq)
- Overlay arrastável com inglês + português
- Tradução grátis (MyMemory) ou paga (mesma API key)
- YouTube: baixa o áudio, transcreve, traduz e **salva o SRT** em `Downloads/Daily Overlay`

Áudio interno de Meet/Discord/YouTube no alto-falante o Android não entrega para apps comuns. No celular usa o microfone (fone com mic perto do áudio da call, ou o som do ambiente). Queimar a legenda no MP4 continua no app do PC.

## Como abrir

1. Instala o [Android Studio](https://developer.android.com/studio)
2. **File → Open** e escolhe a pasta `android/`
3. Deixa o Gradle sincronizar
4. Conecta um celular com USB debugging ou sobe um emulador
5. Clica em Run

Na primeira vez o app pede microfone, notificação e **exibir sobre outros apps**.

## Uso

1. Idioma do áudio (English se a daily for em inglês)
2. Provedor + API key `sk-…` ou `gsk_…`
3. Marca tradução PT
4. **Iniciar transcrição**

Para YouTube, cola o link e toca em **Baixar, transcrever e salvar SRT**. Vídeo muito longo pode passar de 25 MB e o Whisper recusa.

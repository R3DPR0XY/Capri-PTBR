# Capri PT-BR

A Capri de *Cyberpunk: Edgerunners 2* morando no seu desktop do Windows, agora em português do Brasil. Ela conversa, se teletransporta com glitch pela tela, senta nas suas janelas e faz coisas de verdade no seu PC: abre apps, cria timers e lembretes, anota e busca arquivos.

**Versão PT-BR por R3DPR0XY**, baseada no [Capri Companion](https://github.com/TheAgencyMGE/capri-companion) (licença MIT). Projeto de fã não oficial, sem vínculo com CD PROJEKT RED, Studio Trigger ou Netflix.

![Capri no desktop](docs/screenshots/desktop.jpg)

## O que mudou nesta versão

- **Interface inteira em português:** painel, menus da bandeja, notificações, mensagens de erro e confirmações.
- **A Capri responde em português** com qualquer provedor de IA, mantendo as gírias de Night City (choom, preem, nova).
- **Modo sem IA bilíngue:** os comandos diretos entendem português e inglês.
  - "timer de 5 minutos", "coloca um timer de meia hora"
  - "me lembra de alongar daqui a 20 minutos", "me lembra de ligar pra mãe às 18h"
  - "nota: comprar café", "mostra minhas notas"
  - "abrir github.com", "abre o bloco de notas"
  - "procurar arquivos chamados orçamento", "teletransporta", "vem aqui", "que horas são?"
- **Horários em português:** "daqui a", "em", "às 15h", "15h30", "amanhã às 9", "às 8 da noite", "meia hora".
- **Ela entende você falando em português:** um Whisper local vem embutido. Roda no seu PC, sem servidor e sem chave de API.
- **Voz:** prioriza vozes pt-BR do Windows (como a Maria) para responder.
- **Palavra de ativação:** "ei Capri" / "oi Capri" quando houver um reconhecedor de fala em português instalado.
- **Exploração:** quando ativada, abre a Wikipédia em português.

## Instalação (compilando a partir do código)

Compilar você mesmo garante que está rodando exatamente este código, que foi auditado.

Precisa de Windows 10 ou 11 (64 bits) e Node.js 22 ou mais novo.

```
npm install
npm start
```

Use `npm install` (e não `npm ci`) na primeira vez: ele baixa a biblioteca de voz local e atualiza o `package-lock.json`.

Para gerar o instalador `.exe`:

```
npm run dist
```

O instalador sai em `release/Capri-Setup-0.2.0-ptbr.1.exe`. Ele não tem assinatura digital, então o SmartScreen do Windows vai avisar: escolha **Mais informações → Executar assim mesmo**.

## Escolhendo o cérebro dela

Na primeira execução você escolhe a IA:

- **Ollama (recomendado para privacidade):** roda tudo no seu PC. Instale o [Ollama](https://ollama.com), baixe um modelo (por exemplo `ollama pull llama3.2`) e informe o nome dele na aba **Modelo**. Modelos maiores falam português melhor.
- **Google Gemini:** precisa de uma chave gratuita do [AI Studio](https://aistudio.google.com/apikey). É o único que libera o "usar o computador" e o "explorar sozinha".
- **Claude:** entra com a sua conta Claude pelo Claude Code.
- **Outra API:** qualquer endpoint compatível com OpenAI, ou a Anthropic.
- **Sem IA:** só os comandos diretos listados acima.

## Atalhos

| Atalho | Faz |
|---|---|
| Duplo clique nela ou `Ctrl+Alt+Space` | abre o chat |
| `Ctrl+Alt+T` | apertar para falar |
| `Ctrl+Alt+P` | teletransporta |
| `Ctrl+Alt+H` | esconde / mostra |
| `Ctrl+Alt+X` | para de falar / cancela |
| `Ctrl+Alt+C` | interagir por 15 s (com clique atravessando) |
| Arrastar | move; solte na borda de cima de uma janela e ela senta |
| Clique direito nela ou no ícone da bandeja | menu |

## Voz em português

Para falar com ela, ative **Voz → Permitir microfone**. O padrão de **Fala para texto** já é **Whisper local (português, offline)**.

- Na primeira vez, o modelo de voz é baixado do Hugging Face e guardado em `%APPDATA%\Capri\models`. O progresso aparece no chat. Depois disso, tudo funciona sem internet e o áudio nunca sai do seu PC.
- Dá para escolher o tamanho do modelo: **Tiny** (~75 MB, mais rápido), **Base** (~150 MB, o padrão) ou **Small** (~500 MB, entende melhor).
- Segure `Ctrl+Alt+T` (ou o botão do microfone no chat), fale e solte.

O reconhecimento nativo do Windows (System.Speech) continua disponível como opção, mas não tem português. Também dá para usar um servidor compatível com Whisper (local ou a API da OpenAI).

Para a voz dela, instale o pacote de fala em português em **Configurações do Windows → Hora e idioma → Fala**. Ela escolhe a voz pt-BR sozinha.

## Segurança e privacidade

O código desta versão foi auditado antes da tradução. O resultado:

- **Sem telemetria e sem envio de dados escondido.** O app só se comunica com o provedor de IA e o serviço de voz que você escolher.
- **A interface não acessa a internet:** a política de segurança (CSP) bloqueia qualquer conexão a partir das janelas.
- **Electron isolado:** sandbox ligado, `contextIsolation` ativo e `nodeIntegration` desligado. As mensagens internas validam quem as enviou.
- **Chaves de API** criptografadas com o DPAPI do Windows, nunca gravadas em texto puro. O áudio do microfone nunca é guardado e, com o Whisper local, nunca sai do PC.
- **Única conexão nova:** o download do modelo de voz, uma vez, do Hugging Face (huggingface.co).
- **Dependências** vindas só do registro oficial do npm.
- **Atenção:** "usar o computador" e "explorar sozinha" mandam capturas da sua tela para o Gemini. Os dois vêm desligados, pedem confirmação e param com Esc ou quando você mexe o mouse. Ela é proibida de digitar senhas, comprar, apagar arquivos, enviar mensagens ou mudar configurações do sistema.

Tudo fica em `%APPDATA%\Capri`.

## Testes

```
npm test
```

Inclui testes dos comandos e horários em português e da voz local.

## Créditos e licença

- **Versão PT-BR:** R3DPR0XY (tradução e adaptação).
- **Projeto original:** [Capri Companion](https://github.com/TheAgencyMGE/capri-companion), por Capri Companion contributors. O README original está em [README.en.md](README.en.md).

O código é [MIT](LICENSE), mantendo os créditos dos dois. A Capri, o design dela e as imagens de referência pertencem à CD PROJEKT RED, Studio Trigger e Netflix e **não** estão cobertos pela licença MIT. Este é um projeto de fã sem fins comerciais.

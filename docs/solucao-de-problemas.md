# Solução de problemas

Falhas comuns do forge-cli e como resolver cada uma.

## O preflight falha

O preflight roda antes de qualquer prompt e encerra com código `1`
quando algo falta:

| Falha | Causa | Correção |
|---|---|---|
| `git` indisponível | Git não instalado ou fora do `PATH` | Instale o Git e abra um terminal novo |
| `Node.js >= 20` falha | Versão antiga | Atualize via [nodejs.org](https://nodejs.org) ou `nvm` |
| `powershell.exe` indisponível | Somente Windows; fora do `PATH` | Reinstale o PowerShell ou ajuste o `PATH` |

## Falha no clone/pull (`[ERRO]`)

- **Autenticação**: os repositórios são privados. Confirme que suas
  credenciais do Git funcionam — teste `git clone` manualmente em um
  repositório da organização.
- **Rede/VPN**: verifique acesso a `github.com`.
- **Pull com alterações locais**: se a pasta já existe e tem
  modificações, o `git pull` pode falhar. Resolva dentro da pasta do
  repositório e rode o CLI de novo — ele retoma normalmente.

## Falha ao provisionar `.env`

- **Permissão de escrita**: o diretório de destino precisa permitir
  escrita. No Windows, evite pastas protegidas (por exemplo,
  `C:\Program Files`).
- O erro no `.env` **pula o script de instalação** daquele
  repositório de propósito: corrija a causa e rode de novo.

## O script de instalação falha

- **Windows**: o CLI executa
  `powershell.exe -NoProfile -ExecutionPolicy Bypass -File install.ps1`.
  Se a política de execução estiver restrita demais ou o PowerShell for
  o Core (`pwsh`), ajuste o script ou o ambiente.
- **Linux/macOS**: o CLI executa `chmod +x install.sh && ./install.sh`.
  Confirme que o script é válido para o seu shell.
- **Sem script para o SO**: o repositório sai como `[AVISO]`, não
  `[ERRO]` — isso é esperado quando o repo não publica script para a
  sua plataforma.

## O spinner trava ou a saída quebra

- Use um terminal moderno (Windows Terminal, VS Code, ou similar). O
  Prompt de Comando legado pode não renderizar cores/Unicode.
- Scripts de instalação interativos (que pedem input) podem travar —
  prefira scripts não interativos nos repositórios.

## `Ctrl+C` durante a execução

- Nos prompts: `Ctrl+C` cancela de forma limpa.
- Durante clone/script: `SIGINT` encerra com código `130`. O `execa`
  encerra o subprocesso filho junto; uma pasta parcialmente clonada
  pode sobrar — o próximo run faz `git pull` se o `.git` existir, ou
  `git clone` falha se a pasta existe sem `.git` (apague a pasta
  parcial nesse caso).

## `npm install` avisa sobre esbuild

Em ambientes com `allowScripts` restritivo, o postinstall do esbuild é
bloqueado — **o build continua funcionando**, porque os binários de
plataforma vêm como dependências opcionais. Se o `tsup` falhar com
erro de binário esbuild, rode
`npm install-scripts approve esbuild` e reinstale.

## Dependências e versões

- `execa` é fixado em `^9` por decisão de spec — não atualize sem uma
  spec nova.
- `vitest` é `^5` para evitar vulnerabilidades do `tinypool` (ver
  `npm audit`).

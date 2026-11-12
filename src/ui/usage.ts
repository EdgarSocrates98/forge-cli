import { theme } from './theme.js';

const SECTION_RE = /^(Uso|Opções|Extras):$/;
const COMMAND_RE = /^(\s*)(forge-cli)(\s+)(.*)$/;
const FLAG_RE = /^(\s+)(-{1,2}[\w-]+)/;
const COMMENT_RE = /^(\s+)(#.*)$/;

/**
 * Aplica o tema ao texto de ajuda na hora de IMPRIMIR — `usage()`/`usageFor()`
 * continuam devolvendo texto puro (testes e `| grep` intactos); só a superfície
 * TTY recebe cor. Sem TTY/`--no-color`, theme já devolve o texto cru.
 */
export function styledUsage(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      if (SECTION_RE.test(line)) {
        return theme.brand(line);
      }
      const cmd = COMMAND_RE.exec(line);
      if (cmd) {
        const [, indent, name, space, rest] = cmd;
        return `${indent}${theme.brand(name!)}${space}${theme.accent(rest!)}`;
      }
      const flag = FLAG_RE.exec(line);
      if (flag) {
        const [, indent, token] = flag;
        return `${indent}${theme.accent(token!)}${line.slice(indent!.length + token!.length)}`;
      }
      const comment = COMMENT_RE.exec(line);
      if (comment) return theme.dim(line);
      return line;
    })
    .join('\n');
}

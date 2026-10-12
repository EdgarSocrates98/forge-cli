import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { FORGE_REPOS } from '../src/constants/repos.js';
import { askRepos } from '../src/prompts.js';

const strip = (s: string) => s.replace(new RegExp(String.raw`\u001B\[[0-9;?]*[A-Za-z]`, 'g'), '');

function makeIo() {
  const input = new PassThrough() as PassThrough & { isTTY: boolean; setRawMode: () => void };
  input.isTTY = true;
  input.setRawMode = () => undefined;
  const output = new PassThrough();
  let text = '';
  output.on('data', (c) => (text += c.toString()));
  return { input, output, text: () => strip(text) };
}

const press = (io: ReturnType<typeof makeIo>, keys: string[], gap = 40) =>
  keys.forEach((k, i) => setTimeout(() => io.input.write(k), gap * (i + 1)));

describe('askRepos (seleção com busca, teclas simuladas)', () => {
  it('Enter com tudo pré-selecionado devolve todas as Forjas', async () => {
    const io = makeIo();
    const pending = askRepos(FORGE_REPOS, { input: io.input, output: io.output });
    press(io, ['\r']);
    const picked = await pending;
    expect(picked.map((r) => r.name)).toEqual(FORGE_REPOS.map((r) => r.name));
    expect(io.text()).toContain('Pesquisar Forjas');
  });

  it('exibe fase/versão da Forja na dica quando status é informado', async () => {
    const io = makeIo();
    // a dica aparece só na opção em foco; informa todas para não depender de qual está ativa
    const status = new Map(
      FORGE_REPOS.map((r) => [
        r.name,
        { name: r.name, phase: 'validated' as const, head: 'abc1234', dirty: false },
      ]),
    );
    const pending = askRepos(FORGE_REPOS, { input: io.input, output: io.output, status });
    press(io, ['\r']);
    await pending;
    expect(io.text()).toContain('validada');
  });

  it('sem pré-seleção: pesquisa filtra a lista e seleciona a Forja encontrada', async () => {
    const io = makeIo();
    const pending = askRepos(FORGE_REPOS, {
      initialAll: false,
      input: io.input,
      output: io.output,
    });
    // digita "portal", Tab/espaço alterna conforme a UI; Enter confirma
    press(io, ['p', 'o', 'r', 't', 'a', 'l', '\t', '\r']);
    const picked = await pending;
    expect(picked.map((r) => r.name)).toEqual(['forge-portal']);
  });
});

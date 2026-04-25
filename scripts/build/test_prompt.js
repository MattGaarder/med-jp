import { buildPrompt } from '../../src/promptBuilder.js';

async function test() {
  const inputs = [
    'JAP: mune itai',
    'JAP: arerugi nai',
    'JAP: zutsu hidoisugite ugokenai',
    'JAP: memai ga suru no de chotto kowai desu',
    'JAP: genzai mata kako ni ikano jyoutai ni natta koto arimasu ka zensoku mansei heisoku haishikkan haien'
  ];

  for (const input of inputs) {
    console.log('--- TEST INPUT:', input, '---');
    try {
      const result = await buildPrompt(input);
      console.log(result.prompt);
    } catch (e) {
      console.error(e);
    }
    console.log('\n');
  }
}

test();

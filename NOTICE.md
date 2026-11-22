# Kaynaklar ve Lisanslar

## Umay CLI, Umay Code ve Gambit AI CLI

Eklentinin çekirdeği aynı yazarın diğer Umay uygulamalarından gelir:

- `src/umay.js`, `src/agent.js`, `src/tools.js`, `src/processes.js`, `src/chats.js` ve `media/chat.js`'in büyük kısmı [Umay Code](https://github.com/Umay-Official) masaüstü uygulamasından alınıp VS Code'a uyarlanmıştır.
- `src/texttools.js` (metin araç çağrısı protokolü) [Umay CLI](https://github.com/Umay-Official/Umay-CLI)'den gelir; iki kopya birbiriyle aynı tutulmalıdır.
- `src/tools.js`, Umay CLI'nin `python/tools.py` dosyasının Node.js karşılığıdır; o dosya da [Gambit AI CLI](https://github.com/cekYc/gambit-ai-cli) projesinden gelir.

Hepsi bu deponun [LICENSE](LICENSE) koşullarıyla (Umay için ek izin dahil) dağıtılır.

## Pakete gömülen bağımlılıklar

Eklenti paketi (`.vsix`) bu kütüphanelerin kodunu içerir. Her biri kendi lisansıyla dağıtılır.

| Paket | Kullanım | Lisans |
| --- | --- | --- |
| [diff](https://github.com/kpdecker/jsdiff) | Onay kutusundaki değişiklik farkı | BSD-3-Clause |
| [marked](https://github.com/markedjs/marked) | Yanıtlardaki Markdown | MIT |
| [DOMPurify](https://github.com/cure53/DOMPurify) | Markdown çıktısını güvenli hâle getirme | MPL-2.0 veya Apache-2.0 (Apache-2.0 seçilmiştir) |
| [@vscode/codicons](https://github.com/microsoft/vscode-codicons) | Sohbet panelindeki simgeler | Simgeler CC-BY-4.0, kod MIT; © Microsoft Corporation |

Geliştirme araçları (esbuild, @vscode/vsce, ovsx, @vscode/test-electron) pakete girmez.

## Marka

"Umay", "Umay Akıllı", "Umay Hızlı" ve Umay logosu, Umay yapay zeka hizmetinin ([umayzeka.com](https://umayzeka.com)) sahiplerine aittir. Bu eklenti Umay ekibinin isteğiyle Umay ekosisteminin parçası olarak geliştirilmiştir. "Visual Studio Code" ve "VS Code" Microsoft Corporation'ın markalarıdır; bu eklenti Microsoft ile bağlantılı değildir.

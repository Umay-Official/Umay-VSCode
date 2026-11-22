# Yayınlama ve geliştirme

Bu belge eklentiyi geliştirenler içindir. Kullanıcılar için olan sayfa [README.md](README.md)'dir (mağaza sayfasında o görünür).

## Hemen dağıtmak: .vsix dosyası

```powershell
npm ci
npm run package
```

Klasörde `umay-1.0.0.vsix` oluşur. Bu tek dosya her şeyi içerir; kullanıcı:

- **VS Code, Cursor, Windsurf, VSCodium:** Eklentiler bölümü → `···` → **Install from VSIX...** → dosyayı seç. (Dosyayı eklentiler bölümüne sürükle bırak da çalışır.)
- **Komut satırından:** `code --install-extension umay-1.0.0.vsix` (Cursor'da `cursor --install-extension ...`)

Mağazaya çıkmadan önce Discord'da veya GitHub Releases'ta bu dosyayı paylaşmak yeterli.

## 1. GitHub deposu

`package.json` depoyu `Umay-Official/Umay-VSCode` olarak gösterir. Mağaza sayfasındaki ekran görüntüsü (`docs/ekran.png`) bu deponun adresinden yüklenir; depo açılıp push edilmeden önce yayınlanırsa resim görünmez. Depo adı farklı olacaksa `package.json`'daki `repository` ve `bugs` adreslerini değiştir.

## 2. Visual Studio Marketplace (VS Code)

1. <https://marketplace.visualstudio.com/manage> adresine Microsoft hesabıyla gir.
2. **Create publisher**: ID olarak `umay-official` yaz (farklı bir ID alırsan `package.json`'daki `publisher` alanını ona göre değiştir ve paketi yeniden oluştur). Ad: *Umay*.
3. En kolay yol: yayıncı sayfasında **New extension → Visual Studio Code** → `umay-1.0.0.vsix` dosyasını yükle. Doğrulama birkaç dakika sürer, sonra eklenti herkesin aramasında çıkar.

Komut satırından yayınlamak istersen Azure DevOps'tan *Marketplace → Manage* yetkili bir kişisel erişim belirteci (PAT) al:

```powershell
npx vsce login umay-official
npx vsce publish --no-dependencies
```

## 3. Open VSX (Cursor, Windsurf, VSCodium, Trae...)

VS Code dışındaki editörler Microsoft'un mağazasını değil Open VSX'i kullanır; Cursor kullanıcılarına ulaşmak için bu adım gerekli.

1. <https://open-vsx.org> → GitHub hesabıyla giriş.
2. Profil → **Eclipse hesabını bağla** ve *Publisher Agreement*'ı imzala (bir kerelik).
3. Profil → **Access Tokens** → yeni belirteç oluştur.
4. Ad alanını bir kez oluştur, sonra yayınla:

```powershell
npx ovsx create-namespace umay-official -p <BELİRTEÇ>
npx ovsx publish umay-1.0.0.vsix -p <BELİRTEÇ>
```

Ad alanının "doğrulanmış" görünmesi için Open VSX'in GitHub deposunda sahiplik talebi açılabilir (isteğe bağlı).

## 4. Sonraki sürümler: otomatik yayın

`.github/workflows/yayinla.yml`, `v` ile başlayan bir etiket push edildiğinde testleri çalıştırır, paketi oluşturur, GitHub Release'e ekler ve iki mağazaya yükler. Bir kez deponun **Settings → Secrets and variables → Actions** bölümüne şunları ekle:

| Secret | Ne |
| --- | --- |
| `VSCE_PAT` | Marketplace için Azure DevOps belirteci (yoksa o adım atlanır) |
| `OVSX_PAT` | Open VSX belirteci (yoksa o adım atlanır) |

Yeni sürüm:

```powershell
npm version 1.0.1 --no-git-tag-version
# CHANGELOG.md'ye notu ekle, commit at
git tag v1.0.1
git push origin main --tags
```

## Geliştirme

```powershell
npm ci
npm run build          # dist/extension.js
npm test               # birim testleri (sahte sunucu, API harcamaz)
npm run test:vscode    # gerçek VS Code içinde uçtan uca testler
```

VS Code'da bu klasörü açıp **F5** ile *Extension Development Host* penceresinde deneyebilirsin (`npm run watch` değişiklikleri anında derler).

`npm run test:vscode` VS Code'un kararlı sürümünü indirir. Kurulu VS Code'u kullanmak için: `$env:VSCODE_PATH = "$env:LOCALAPPDATA\Programs\Microsoft VS Code\Code.exe"`.

## Yapı

```text
src/
  extension.js   Etkinleştirme: kenar çubuğu, komutlar, sağ tık menüsü, ampul menüsü, durum çubuğu
  panel.js       Sohbet panelinin eklenti tarafı: anahtar, turlar, onaylar, fark görünümü, dosya açma
  context.js     Açık dosya ve seçili koddan mesaja eklenen bağlam
  keystore.js    Anahtar: VS Code'un güvenli kasası, UMAY_API_KEY, Umay CLI'den alma
  umay.js        Umay API istemcisi (Umay Code'dan)
  agent.js       Ajan döngüsü: yanıt → araç çağrıları → onay → sonuçlar (Umay Code'dan)
  tools.js       Araçlar; yollar açık klasörle sınırlı (Umay Code'dan)
  processes.js   Arka plan süreçleri (Umay Code'dan)
  texttools.js   Metin araç çağrısı protokolü (Umay CLI'den; onunla aynı tutulmalı)
  chats.js       Sohbet geçmişi (Umay Code'dan)
media/
  chat.js        Sohbet paneli (webview); anahtarı hiç görmez
  chat.css       Editör temasına uyan görünüm
  umay.svg       Etkinlik çubuğu simgesi
  icon.png       Mağaza simgesi
scripts/build.mjs  esbuild ile tek dosyaya paketleme
test/            Birim testleri; test/vscode/ gerçek VS Code içinde çalışan testler
```

Umay CLI veya Umay Code'daki ortak dosyalar (`texttools.js`, `tools.js`, `agent.js`, `umay.js`) değişirse buradaki kopyaları da güncelle.

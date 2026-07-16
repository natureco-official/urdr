# PLAN.md — Urðr: tüm bulguları düzelt + tüm önerileri uygula (v1)

**Core Focus:** ISSUES.md'deki (iki bağımsız incelemenin birleşik listesi) TÜM bug'ları düzelt ve TÜM önerilen özellikleri uygula, ardından gerekli testleri yaz/çalıştır. Kullanıcı kapsamı açıkça onayladı ("tüm sorunları düzeltip tüm önerileride uygulayalım ardından gerekli testleri yapalım") — filtreleme/önceliklendirme YOK, hepsi bu cycle'ın kapsamında.

**Proje:** C:\Projects\urdr-main, git ile github.com/natureco-official/urdr'a bağlandı (içerik zaten origin/main ile birebir aynıydı, sadece git geçmişi eklendi). Yerel `önce oku github.txt` dosyası .gitignore'da, push'a dahil değil.

**AÇIK TASARIM SORUSU (Same Page Meeting'de çözülecek):** Rock 7 (event-log mimarisi) TEMELDE mevcut dosya-okuma modelini değiştiriyor. Rock 1-6'nın bazı düzeltmeleri (özellikle parser/leaf modeli, lint, search) Rock 7'den SONRA gereksiz veya yanlış kapsamda kalabilir. Codex'in bu sıralamaya (7 önce mi sonra mı, yoksa iki aşamalı mı — önce mevcut modeli düzelt/stabilize et, SONRA event-log'u üstüne inşa et) itirazı olacaksa Same Page Meeting'de netleşsin.

---

## Rock 1 — Core parsing/veri-modeli düzeltmeleri

**Done looks like:**
- `search.mjs`/`lint.mjs`/`append.mjs`: çok satırlı HTML yorumları doğru atlanıyor (sadece ilk satır değil, `<!--...-->` bloğunun TAMAMI).
- Yaprak (leaf) sınırı doğru tanımlanıyor — her dolu satır değil, gerçek madde işareti/paragraf birimi bir "leaf" sayılıyor.
- Türkçe (`_Henüz kayıt yok._`) VE İngilizce (`_No entries yet._`) placeholder'lar her ikisi de tanınıyor (search'te atlanıyor, append'te doğru replace ediliyor, lint'te leaf sayılmıyor).
- Eşik kontrolleri protokolle uyumlu: dal sayısı ≥9 uyarı (>9 değil), leaf sayısı dal başına ≥50 uyarı, ≥30 "yakında bölünmeli" sinyali (growth-rules.md'deki gerçek dille birebir eşleşsin).
**Dosyalar:** `scripts/search.mjs`, `scripts/append.mjs`, `scripts/lint.mjs`
**Proof:** `node scripts/lint.mjs ./templates` → 0 sahte uyarı (şu an 37 var, hepsi placeholder yanlış-pozitifi). `node scripts/selftest.mjs` yeşil. Yeni bir Türkçe-özel test senaryosu (append + lint + search Türkçe ağaçta doğru çalışıyor) eklenir ve geçer.

## Rock 2 — Concurrency & durability sertleştirme

**Done looks like:**
- Lock mekanizmasına owner-token (benzersiz writer ID) + heartbeat eklenir — stale-lock çalma SADECE gerçekten ölü/heartbeat'i durmuş bir writer için olur, canlı-ama-yavaş bir writer'ın kilidi çalınamaz. Release, SADECE kendi owner-token'ını taşıyan kilidi siler (başkasının çalıntı/yeni kilidini yanlışlıkla silmez).
- Atomic write: rename öncesi `fsync`, hata durumunda temp dosya temizleniyor, orijinal dosyanın mode'u korunuyor.
- `rootFile` parametresi path-traversal'a karşı doğrulanıyor (sadece memory dizini içinde, `../` reddediliyor).
- `leafText` içindeki `##` (yeni başlık enjeksiyonu) escape ediliyor veya reddediliyor.
**Dosyalar:** `scripts/append.mjs`
**Proof:** Yeni bir test: "canlı ama 30sn+ süren writer'ın kilidi çalınamaz" senaryosunu simüle edip doğrular (owner-token düzeltmesini test eder — mevcut selftest bunu kapsamıyordu). Path-traversal ve header-injection için de negatif testler.

## Rock 3 — migrate.sh / init.sh / check-growth.sh düzeltmeleri

**Done looks like:**
- `migrate.sh`: BSD-sed yerine `init.sh`'daki gibi cross-platform sed fallback deseni. `split` doğru header formatı üretir. `move` içeriği hedef dalın İÇİNE ekler (dosya sonuna değil). `new-root` protokolün istediği `root-4-<isim>.md` adını üretir (Node regex'iyle eşleşir), kaynaktan siler (kopyalamaz, "single primary" korunur), kısmi hatada rollback yapar.
- `init.sh`: var olan dosyaları ezmeden önce kontrol/backup, `--lang` değerini doğrular, kullanıcı girdisini sed'e güvenli şekilde geçirir (özel karakter escape), `--no-git`/`--force` bayrakları eklenir, iç içe git repo riski kontrol edilir.
- `check-growth.sh`: deprecated olduğu için ya TAMAMEN kaldırılır (yerine sadece `lint.mjs` kalır, migrate.sh'daki referansı güncellenir) ya da argüman ayrıştırma hatası düzeltilir — Codex build sırasında karar verir (kaldırmak muhtemelen daha temiz, zaten Node'a geçiş yapılmış).
**Dosyalar:** `scripts/migrate.sh`, `scripts/init.sh`, `scripts/check-growth.sh` (muhtemelen silinir)
**Proof:** Her migrate.sh komutu (split/move/new-root) için yeni testler, hem macOS-sed hem GNU-sed'i simüle eden bir ortamda (bu ortam GNU-sed olduğu için en azından burada gerçekten çalıştığı doğrulanır). init.sh için: var olan dosya üzerine yazmama testi, geçersiz --lang reddi testi.

## Rock 4 — Lint tamlığı + CI sertleştirme

**Done looks like:**
- `lint.mjs`: dokümante edilen ama uygulanmayan kontroller eklenir — 2-hop `bkz:` zincir derinliği, root'lar arası duplicate tespiti (sadece aynı root değil), hedef dal varlığı doğrulaması.
- CI: migrate.sh ve init.sh gerçekten test ediliyor (en azından Linux runner'da). `lint.mjs` çıktısı değerlendiriliyor (WARNING'de de exit kodu kontrol ediliyor, sadece "çökmüyor mu" değil). Concurrency/race, CRLF, path-traversal, Türkçe placeholder senaryoları CI'da test ediliyor.
**Dosyalar:** `scripts/lint.mjs`, `.github/workflows/ci.yml`, `scripts/selftest.mjs` (yeni testler eklenir)
**Proof:** CI konfigürasyonu yerelde `act` ile veya en azından her adımın komutu manuel çalıştırılarak doğrulanır (gerçek GitHub Actions'a push edilmeden). Yeni lint kontrollerinin gerçek kırık referanslar/duplicate'ler üzerinde doğru çalıştığı gösterilir.

## Rock 5 — Dokümantasyon + entegrasyon tutarlılığı

**Done looks like:**
- README'deki `kók-*` → `kök-*` düzeltilir, var olmayan dosyalara referanslar (protocols/mimari.md, examples/project-tracking, examples/technical-reference) ya oluşturulur ya da referans kaldırılır (Codex hangisinin daha uygun olduğuna karar verir — muhtemelen referans kaldırma, gereksiz dosya şişkinliği istemiyoruz).
- integrations/ altındaki TÜM dosyalar deprecated `check-growth.sh`/grep yerine `lint.mjs`/`search.mjs`'i referans alacak şekilde güncellenir.
- Hermes entegrasyonu (`always` tüm root yükleme) `<300 token` tasarımıyla uyumlu hale getirilir (lazy/on-demand yükleme).
- OpenClaw'ın kendi dokümanı içindeki MEMORY.md tanım tutarsızlığı (bir yerde Root-1+Root-3, başka yerde sadece Root-1) tek bir tutarlı tanıma indirilir.
**Dosyalar:** `README.md`, `integrations/**`, `protocols/**` (referans temizliği)
**Proof:** Kod okuma ile her referansın gerçekten var olan bir dosyaya/komuta işaret ettiği teyit edilir.

## Rock 6 — Hibrit retrieval + gerçek benchmark + telemetri

**Done looks like:**
- `search.mjs`: BM25/trigram tabanlı skorlama eklenir (mevcut literal regex fallback olarak kalır), typo toleransı (basit edit-distance), ReDoS'a açık regex desenleri güvenli hale getirilir.
- `bench.mjs`: metodoloji düzeltilir — "write fidelity" gerçek `append.mjs` çağrılarıyla ölçülür (writeFileSync bypass değil), "hierarchy-only" recall gerçekten SADECE doğru root'a bakarak ölçülür (önce tüm ağacı tarayıp sonra filtrelemez), sentetik veri artık her leaf'e benzersiz anahtar vermez (gerçekçi ambiguity senaryoları).
- Basit bir kullanım-telemetrisi (yerel, opsiyonel) — hangi sorgu hiyerarşiyle hangisi fallback'le bulundu, hangi sorgular sonuçsuz kaldı, `.urdr-telemetry.jsonl` gibi yerel bir dosyaya (opt-in) yazılır.
**Dosyalar:** `scripts/search.mjs`, `scripts/bench.mjs`, YENİ `scripts/telemetry.mjs` (opsiyonel modül)
**Proof:** Düzeltilmiş bench.mjs'in ESKİ ve YENİ sonuçları karşılaştırmalı raporlanır (metodoloji farkının gerçek etkisini göstermek için). Typo-toleranslı arama için pozitif/negatif test senaryoları.

## Rock 7 — Event-log mimarisi (stable ID + provenance + transaction + forgetting + memory-compiler) + MCP server paketlemesi

**Done looks like:**
- Her leaf'e kalıcı, değişmez bir ID atanır (dosya/dal yeniden adlandırılsa bile kırılmaz).
- `supersedes`/`derived-from`/`conflicts-with` ilişkileri leaf metadata'sında tutulur.
- Append-only bir olay günlüğü (ör. `.urdr/events.jsonl`, checksummed) asıl doğruluk kaynağı olur; root Markdown dosyaları bu günlükten türetilen "materialized view"lardır (insan hâlâ Markdown okur/düzenler, ama sistem event log'u referans alır).
- Her leaf'te provenance/epistemik durum (kaynak, oluşturan ajan, zaman, güven düzeyi, doğrulama durumu) tutulur.
- Cross-cutting kuralının gerektirdiği "primary + birkaç bkz:" çoklu-dosya yazımı TEK atomik transaction'da yapılır (ya hepsi görünür olur ya hiçbiri).
- Retention/forgetting politikası: leaf'lere retention sınıfı atanabilir, kullanıcı-tetiklemeli "unut" komutu, hassas veri redaksiyonu.
- `lint.mjs`'in bulduğu sorunlar için "memory compiler" dry-run modu: somut bir düzeltme planı (dal bölme önerisi, index diff'i, kırık referans düzeltmesi) üretir, onay sonrası tek transaction'da uygular.
- search/append/lint/compiler işlemleri bir MCP server olarak paketlenir (Claude Desktop/Code, Cursor gibi ortamlarda doğrudan tool call ile kullanılabilir — shell'den manuel çağırma gerekmez).
**Dosyalar:** YENİ `scripts/event-log.mjs` (çekirdek), YENİ `scripts/compiler.mjs` (dry-run), YENİ `mcp-server/` (MCP server paketi), mevcut `search.mjs`/`append.mjs`/`lint.mjs` event-log'u kullanacak şekilde uyarlanır, `protocols/architecture.md` güncellenir.
**Proof:** Event-log'dan üretilen Markdown'ın insan tarafından okunabilir kaldığı (mevcut format korunuyor) gösterilir. Transaction'ın atomikliği (yarım kalan bir transaction'ın hiçbir etkisi olmadığı) test edilir. MCP server'ın gerçek bir MCP client'la (ör. basit bir test script'i) konuşabildiği doğrulanır. Stable ID'lerin rename sonrası kırılmadığı test edilir.

---

## Ortak proof
```
node scripts/selftest.mjs
node scripts/lint.mjs ./templates
node scripts/bench.mjs --leaves 300 --ambiguity 0.3
```
Her rock sonrası selftest yeşil kalmalı (regresyon yok).

## Non-goals
- Gerçek bir vector DB/embedding entegrasyonu YOK (Codex'in "opsiyonel semantic fallback" önerisi net şekilde AÇIKÇA ETİKETLENMİŞ ve varsayılan olarak KAPALI kalmalı — LLM-free felsefe korunuyor).
- Deploy/npm publish YOK (bu cycle'da sadece kod + test).
- GitHub'a push YOK (kullanıcı ayrıca onaylayacak).

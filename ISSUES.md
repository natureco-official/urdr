# ISSUES.md — Urðr kapsamlı denetim bulguları (2026-07-17)

İki bağımsız incelemenin (Claude fork + Codex CLI, birbirinden habersiz, paralel) birleşik listesi. Kullanıcı "tüm sorunları düzeltip tüm önerileri uygulayalım" dedi — bu dosya PLAN.md'nin kaynağı.

## Kritik bug'lar (ikisi de bağımsız buldu)

1. **Türkçe placeholder tanınmıyor** — `search.mjs`, `append.mjs`, `lint.mjs` sadece `_No entries yet._` arıyor, Türkçe şablondaki `_Henüz kayıt yok._` değil. Ampirik doğrulandı: taze şablonlarda 37 sahte lint uyarısı.
2. **`migrate.sh` cross-platform kırık** — BSD-sed sözdizimi (`sed -i ''`), GNU fallback yok. Ek olarak: `split` yanlış header formatı (`## ## Projects`), `move` içeriği hedef dala değil dosya sonuna ekliyor, `new-root` protokolün istediği `root-4-<isim>.md` yerine Node regex'iyle eşleşmeyen bir ad üretiyor.
3. **CI bunları yakalamıyor** — migrate.sh/init.sh hiç test edilmiyor, lint sadece "çökmüyor mu" kontrolü yapıyor (çıktı değerlendirilmiyor), sadece ERROR'da exit 1 (WARNING'de değil).

## Codex'in tek başına bulduğu (derin kod okumasıyla)

4. **Parser/leaf modeli temelde yanlış** — çok satırlı HTML yorumların sadece ilk satırı atlanıyor, her dolu satır ayrı yaprak sayılıyor.
5. **Stale-lock race condition** — 30sn+ süren ama hâlâ canlı bir writer'ın kilidi çalınabiliyor; orijinal sahip işini bitirip release ederken YENİ sahibin kilidini siliyor.
6. **Lint dokümante ettiği kontrolleri yapmıyor** — 2-hop `bkz:` zincir derinliği hiç uygulanmamış; duplicate kontrolü sadece aynı root içinde (asıl risk olan root'lar arası kopya yakalanmıyor); hedef dal varlığı doğrulanmıyor.
7. **Off-by-one eşik hataları** — `>9`/`>50`/`>30` yerine "9+"/"50'ye ulaşınca" olmalıydı.
8. **Benchmark metodolojisi kendi iddialarını kanıtlamıyor** — her sentetik kayıt benzersiz anahtar taşıyor (%100 recall kaçınılmaz); "write fidelity" gerçek `append.mjs` yerine `writeFileSync` ile ölçülüyor.
9. **`append.mjs`'e path traversal + header-injection riski** — `rootFile`'da `../`, `leafText`'te `##` enjeksiyonu.
10. **Atomic write durability boşlukları** — fsync yok, rename'de mode/ACL korunmuyor, hata durumunda temp dosya temizlenmiyor.
11. **`init.sh` riskleri** — yedeksiz üzerine yazma, `--lang` doğrulanmıyor, kullanıcı adındaki özel karakterler sed'i bozabilir, iç içe git repo riski.
12. **`check-growth.sh` argüman ayrıştırma hatası** — `MEMORY_DIR` ilk argümana atanıyor, `--verbose` bir dizin adı gibi işleniyor.
13. **Entegrasyon tutarsızlıkları** — Hermes TÜM root'ları her zaman yüklüyor (`<300 token` tasarımıyla çelişiyor), OpenClaw'ın kendi dokümanında MEMORY.md tanımı tutarsız.
14. **Dokümantasyon güncel değil** — README'de `kók-*` yazım hatası (gerçek `kök-*`), var olmayan dosyalara referans (`protocols/mimari.md`, `examples/project-tracking`, `examples/technical-reference`), entegrasyonlar hâlâ deprecated `check-growth.sh`/grep öneriyor.
15. **ReDoS riski** — search.mjs'in varsayılan regex'i pahalı geri-izleme desenlerine açık.

## Büyük fark yaratacak özellikler (ikisinin birleşimi)

16. **MCP server paketlemesi** — search/append/lint birer tool call olsun, shell'den manuel çağırma bitsin.
17. **Stable memory ID + doğrulanabilir referans grafiği** — serbest metin `bkz:` yerine kalıcı ID + `supersedes`/`derived-from`/`conflicts-with` ilişkileri.
18. **Event-log + Markdown "materialized view"** — asıl doğruluk kaynağı append-only olay günlüğü, root dosyaları ondan türetilir (concurrency/rollback/audit tek mimaride).
19. **Hibrit retrieval** — yapı → BM25/trigram → opsiyonel semantic; typo toleransı, Türkçe kök/ek farkındalığı.
20. **Provenance/epistemik durum** — her yaprakta kaynak, güven düzeyi, doğrulayan, geçerlilik aralığı.
21. **Çoklu dosya transaction/journal** — cross-cutting kuralının gerektirdiği "primary + birkaç bkz:" tek atomik işlemde yazılsın.
22. **Unutma/redaksiyon/retention politikası** — "asla silme" yerine retention sınıfları, kullanıcı-tetiklemeli unutma, hassas veri redaksiyonu.
23. **"Memory compiler" dry-run** — lint sadece uyarmasın, somut bir düzeltme planı (dal bölme önerisi, index diff'i, kırık referans düzeltmesi) üretsin, onay sonrası tek transaction'da uygulasın.
24. **Gerçek kullanım telemetrisi** — hangi sorguların hiyerarşiyle hangilerinin fallback'le bulunduğunu, hangi sorguların sonuçsuz kaldığını yerel/anonim kaydet.
25. **Otomatik dal bölme** — leaf'leri ortak anahtar kelimelere göre kümeleyip alt-dal öner.

## Test gereksinimleri (kullanıcı "gerekli testleri yapalım" dedi)
- Mevcut `selftest.mjs`'i çalıştır (regresyon yok mu).
- Türkçe placeholder + parser düzeltmesi için yeni testler.
- Concurrency/stale-lock race senaryosu için yeni test (owner-token düzeltmesini doğrulamak için kasıtlı olarak "yavaş ama canlı" bir writer simüle et).
- migrate.sh'ın (düzeltilmiş haliyle) her 3 komutu (split/move/new-root) için yeni testler.
- CI'ya migrate.sh/init.sh + concurrency/race + CRLF + path-traversal + Türkçe testleri ekle.
- Yeni özellikler (MCP server, hibrit retrieval, event-log) için kendi test setleri.

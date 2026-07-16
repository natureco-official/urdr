# SAME-PAGE-LOG.md — Urðr

## Round 1

### Integrator findings (Codex, verbatim)
(bkz. Same Page Meeting round 1 çıktısı — 48 bulgu, tamamı [FIX] veya [KILL] veya [CLARIFY], neredeyse hiç [DEFER] yok. Tam liste bu conversation'ın geçmişinde duruyor, burada özetlenmiyor çünkü hepsi PLAN v2'ye işlendi.)

### Visionary response (Fable)

Neredeyse TÜM bulgular kabul edildi — Codex'in gerekçeleri teknik olarak sağlam, reddedilecek bir şey bulamadım. Üç en önemli, plan mimarisini değiştiren kabul:

1. **KABUL (kritik mimari düzeltme) — Rock 7 sıralaması:** "Ne baştan ne sondan" — schema/migrator + stable-ID + idempotent import erken kurulmalı (uyumluluk katmanı), SONRA lint/search/compiler bu event-log'u kullanacak şekilde taşınmalı, MCP paketleme EN SONA. Rock 7 artık tek bir "sona bırakılan büyük rock" değil, PLAN v2'de kademeli alt-adımlara bölündü (Rock 6, 5 alt-aşama).
2. **KABUL (kritik teknik düzeltme) — Heartbeat senkron writer'da çalışmaz:** Node'un tek-thread event loop'unda, senkron blocking I/O sırasında bir timer callback'i (heartbeat) ateşlenemez. Owner-token fikri kalıyor ama "heartbeat" yerine OS-tabanlı kilit (flock benzeri) veya ayrı bir lease-keeper process gerekiyor. Rock 1'e işlendi.
3. **KABUL (mimari sadeleştirme) — Tek paylaşılan parser modülü:** Rock 1 (eski)'in 3 ayrı dosyada (search/append/lint) ayrı ayrı regex yamalamak yerine, TEK bir kanonik Markdown parser/leaf-grammar modülü (multi-line yorumlar, gerçek leaf sınırları — continuation/nested-list/table/blockquote/code-fence, EN+TR placeholder) yazılıp append/search/lint/migrate/bench/event-log-import'un HEPSİ bunu kullanması gerekiyor. Bu, Rock 7'nin Markdown-import ihtiyacıyla da doğrudan örtüşüyor — YENİ Rock 0 olarak öne alındı.

Diğer kabul edilen, plana işlenen düzeltmeler (özet — detaylar PLAN v2'de):
- Path-traversal: substring "../" reddi YETERSİZ, realpath-tabanlı confinement gerekiyor (symlink/absolute-path/case-trick bypass'larını da kapatır).
- Header-injection: blanket "##" reddi meşru içeriği kırar, sadece parser'ın TANIDIĞI heading node'ları (code-fence dışında) reddedilmeli.
- migrate.sh: sed/awk yerine Node'a taşınıp Rock 0'ın parser'ını kullanmalı; `move` komutu hedef dal parametresi almalı (şu anki arayüz eksik); `new-root` dinamik olarak bir sonraki boş root numarasını bulmalı (root-4 hardcode değil); `split` non-interactive/plan-file modu almalı (CI'da test edilebilir olsun).
- init.sh: `--lang both` iki paralel "gerçek" ağaç yaratıp single-primary-truth kuralını bozuyor — dil sadece sunum/isimlendirme tercihi olmalı, TEK birincil ağaç + alias'lar.
- check-growth.sh: KILL — tamamen kaldırılıyor (Codex'in kendi önerisi, zaten deprecated).
- CI: blanket "warning'de de fail" yerine açık `--fail-on-warn` politikası + golden-fixture/snapshot testleri.
- Cross-root duplicate: O(n²) pairwise yerine token-index candidate generation; referans/bkz: leaf'lerini duplicate sanmaması için hariç tutulmalı.
- Arama: varsayılan LİTERAL (regex değil) — hem ReDoS riskini varsayılan olarak ortadan kaldırır hem basitleştirir; regex sadece açık, sınırlı, doğrulanmış bir modda.
- Türkçe morfoloji: generic "typo tolerance" yeterli değil, gerçek Türkçe ek/kök farkındalığı gerekiyor.
- Benchmark: ground truth stable-ID'lerle kurulmalı (query başına benzersiz anahtar yerine), "hierarchy-only" iddiası gerçekten SADECE ilgili dosyanın okunduğunu enstrümante ederek kanıtlanmalı.
- Telemetri: varsayılan KAPALI + hash'lenmiş/minimize edilmiş + gitignore'da + rotate ediliyor + "hiç secret loglanmıyor" testi.
- Memory-compiler: dry-run planı input hash'ine bağlanmalı, plan üretildikten sonra ağaç değiştiyse "stale" reddedilmeli.
- MCP: realpath confinement + symlink reddi + sınırlı input/output + explicit tool schema + adversarial client testleri + gerçek paket manifesti/lock/protokol testi/clean-install testi.

**REDDEDİLEN:** Yok — bulguların hepsi teknik olarak haklıydı.

PLAN.md v2'ye işlendi (Rock 0 yeni eklendi, Rock 7 kademeli alt-adımlara bölündü, tüm diğer rock'lar spesifik düzeltmelerle güncellendi).

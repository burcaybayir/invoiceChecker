# Suşi Treni: Oyun Tasarım Belgesi

Döner suşi barında geçen, sıralama ve zamanlama üzerine kurulu bir casual bulmaca oyunu. Referans: *Tasty Travels* tarzı "konveyör + sütun" oyunları.

Oynanabilir prototip: `sushi-treni/index.html`

## 1. Tek cümlelik fikir

Tezgâhın etrafında dönen bir bant var. Aşağıdaki sütunlardan tabakları banta gönderiyorsun, müşteriler de istedikleri suşi önlerinden geçtiğinde alıyor. Bandı taşırmadan her tabağı servis etmen gerekiyor.

## 2. Çekirdek döngü

1. **Oku:** Dört müşteri balonunda bir tür ve adet istiyor (ör. 🍣 ×4).
2. **Seç:** 5 sütundan birine dokun. En üstte yan yana duran aynı türdeki tabaklar grup olarak banta çıkar.
3. **Bekle:** Bant tabakları giriş kapağından alır ve saat yönünde döndürür. Siparişle eşleşen tabak müşterinin önünden geçerken otomatik olarak alınır.
4. **Ödül:** Her tabak +1 altın, tamamlanan her sipariş +5 altın. Siparişini alan müşteri kalkar, yerine yeni sipariş veren biri oturur.
5. Bütün tabaklar servis edilince seviye biter.

## 3. Kurallar

| Öğe | Kural |
|---|---|
| Sütunlar | 5 adet. Yalnızca en üstteki aynı tür grup gönderilebilir. |
| Bant kapasitesi | Banttaki ve kuyruktaki tabak sayısı kapasiteyi aşamaz. Yer yetmezse grubun sığan kadarı gider. |
| Siparişler | Kalan tabaklardan üretilir ve başka siparişe ayrılmamış tabaklar kullanılır, yani seviye her zaman çözülebilir. Son sipariş artık tabak bırakmaz. |
| Kaybetme | Bant tamamen dolu ve oturan dört müşterinin hiçbiri banttaki bir türü istemiyorsa bant tıkanır. |
| Kazanma | Tüm tabaklar servis edilir. |
| Yıldız | En yüksek bant doluluğuna göre verilir: %75'in altı 3★, %92'nin altı 2★, üstü 1★. Bu, oyuncuyu bandı gereksiz doldurmamaya teşvik eder. |

## 4. Strateji derinliği

- **Kazma:** İstenen tür sütunun altında gömülüyse önce üstteki tabakları çıkarman gerekir. Bunlar banta çöp gibi yığılır, yani her hamle yer tüketir.
- **Zamanlama:** Bant tek yönlü döner. Giriş kapağından sonra ilk sıradaki müşteri sol alttakidir, öbürleri tabağı daha geç görür.
- **Sipariş tahmini:** Bant doldukça yeni müşteriler banttaki türleri isteme eğilimindedir. Bu bir kurtarma mekanizmasıdır ama tahmin edilebilir değildir.

## 5. Güçlendiriciler

| Güçlendirici | Etki | Prototipte |
|---|---|---|
| Geri al | Son gönderilen grubun hâlâ bantta ya da kuyrukta olan tabaklarını sütuna geri koyar. Seviye başına 3 hak. | Var |
| Hız ×2 | Bandı iki kat hızlandırır. Ücretsiz, açılıp kapanabilir. | Var |
| Karıştır | Bir sütunun sırasını karıştırır. | Fikir |
| Tabak tepsisi | Banttan bir tabağı alıp geçici bir cebe koyar (1 slot). | Fikir |
| Sabırsız müşteri | İleri seviyelerde sabır süresi olan VIP müşteri, daha çok altın verir. | Fikir |

## 6. Seviye eğrisi

| Parametre | Formül | Sv. 1 | Sv. 5 | Sv. 8+ |
|---|---|---|---|---|
| Tür sayısı | min(3+n, 9) | 4 | 8 | 9 |
| Toplam tabak | 40 + 10n | 50 | 90 | 120+ |
| Bant kapasitesi | max(30, 46 − 2n) | 44 | 36 | 30 |
| Başlangıçta banttaki tabak | kapasitenin %35'i | 15 | 12 | 10 |
| Sipariş büyüklüğü | 2 ile min(3+n, 8) arası | 2–4 | 2–8 | 2–8 |
| Bant hızı | 2,4 slot/sn × (1 + 0,04(n−1)) | 2,4 | 2,8 | 3,1+ |

Sütunlar 1–4 (erken seviyelerde) veya 1–3 uzunluğunda aynı tür gruplarından oluşur ve rastgele dağıtılır.

## 7. Tabaklar

Kaiten-zushi'de tabak rengi fiyatı gösterir. Oyunda da her türün kendine ait bir tabak rengi var, böylece tabaklar bant üzerinde hızlıca ayırt edilir.

Somon 🍣 · Karides 🍤 · Ahtapot 🐙 · Onigiri 🍙 · Tamago 🥚 · Kappa 🥒 · Yengeç 🦀 · Naruto 🍥 · Kalamar 🦑

## 8. Ekran düzeni (dikey, telefon)

```
┌────────────────────────────┐
│ Seviye   Servis 12/50   🪙  │  HUD
│ 👩 [🍣×4]        [🦀×2] 🧔 │
│   ╭──── döner bant ────╮    │
│   │      👨‍🍳 şef        │    │  Bant + mutfak
│   ╰────── [giriş] ─────╯    │
│ 👵 [🍙×3]        [🥒×5] 👦 │
│ Bant  ███████░░░  28/44     │  Kapasite çubuğu
│ ┃🍣┃ ┃🦀┃ ┃🍤┃ ┃🍙┃ ┃🥒┃     │
│ ┃🍣┃ ┃🍥┃ ┃🍤┃ ┃🍙┃ ┃🐙┃     │  5 sütun (üst grup parlar)
│ ┃🥚┃ ┃🍥┃ ┃🦑┃ ┃+4┃ ┃🐙┃     │
│ [Geri al 3] [Hız ×2] [Menü] │
└────────────────────────────┘
```

## 9. Meta ilerleme (sonraki adımlar)

- **Seyahat haritası:** Her 10 seviyede yeni şehir (Tokyo → Osaka → İstanbul füzyon barı), yeni tabak türleri ve dekor.
- **Altın harcama:** Güçlendirici satın alma, restoran dekorasyonu.
- **Günlük görev:** "Bugün 30 somon servis et" gibi hedefler.
- **Gelir modeli (opsiyonel):** Can sistemi + ödüllü reklamla ekstra geri al hakkı. Seviye bitirmeye engel olan ödeme duvarı yok.

## 10. Teknik notlar (prototip)

- Tek dosyada HTML + Canvas + saf JavaScript, bağımlılık yok.
- Bant, kapasite kadar eşit aralıklı slottan oluşur. Slotlar yuvarlatılmış dikdörtgen bir yol boyunca döner. Giriş kapağı ve her müşteri yolda sabit bir noktadır ve önlerinden yeni bir slot geçtiğinde işlem yaparlar.
- Siparişler "kalan − ayrılmış" stoktan üretildiği için seviye matematiksel olarak her zaman bitirilebilir.
- İlerleme (açılan seviye, toplam altın) `localStorage`'da tutulur.
- Klavye: 1–5 sütunlar, Z geri al, Esc menü.

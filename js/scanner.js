/**
 * 7-11 商品卡皮夾 - 極速「一拍雙讀」與純數字卡號智能辨識模組 (scanner.js - v6)
 * 
 * 核心升級與技術亮點：
 * 1. 嚴格限定「第一段卡號必為純數字」：
 *    - 7-11 商品卡主卡號一定是 10~24 碼純數字 (/^\d{10,24}$/)。
 *    - 含有英文字母或過短的檢核碼，絕對不會被誤判定為第一段卡號！
 * 2. 「一拍雙讀」一秒同時辨識兩段條碼 (Simultaneous Dual Barcode Recognition)：
 *    - 擴大取景框使鏡頭能同時涵蓋上下兩段條碼。
 *    - 啟動高效原生 BarcodeDetector 多條碼併發偵測 + 0.6 秒智慧收集緩衝：
 *      對準卡片 ➔ 同時或瞬間收集到 (純數字卡號 + 檢核碼) ➔ 1 秒直接完成一張卡片並自動拍照！
 * 3. 亦支援分步智能補齊：若鏡頭先看到其中一段，0.5 秒內看到另一段立即自動合併存入。
 */

class CardScanner {
  constructor() {
    this.html5QrCode = null;
    this.nativeBarcodeDetector = null;
    this.isScanning = false;
    this.detectLoopId = null;
    
    this.recentScans = new Map();
    this.currentBatchCards = [];
    this.selectedFaceValue = 100;
    this.presetType = 'money'; // 'money' | 'item'
    this.presetItemName = '商品兌換券';
    this.scanMode = 'dual'; // 'dual' (雙段) | 'single' (單段)
    this.cameras = [];
    this.isTorchOn = false;

    // 雙段智慧收集緩衝
    this.scanMode = 'dual'; // 'dual' | 'single'
    this.collectedCode1 = null; // 暫存的純數字卡號
    this.collectedCode2 = null; // 暫存的檢核碼
    this.collectTimer = null;
    this.isCardProcessing = false;
  }

  initAudio() {
    if (!this.audioCtx) {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      if (AudioContext) {
        this.audioCtx = new AudioContext();
      }
    }
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  playBeep(type = 'success') {
    try {
      this.initAudio();
      if (!this.audioCtx) return;

      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      if (type === 'step1') {
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1600, now);
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.1);
      } else if (type === 'duplicate') {
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(700, now);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.18);
        osc.start(now);
        osc.stop(now + 0.18);
      } else {
        // 完成雙嗶音 (清脆連音 2000Hz -> 2600Hz)
        osc.type = 'sine';
        osc.frequency.setValueAtTime(2000, now);
        osc.frequency.setValueAtTime(2600, now + 0.06);
        gain.gain.setValueAtTime(0.35, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.18);
        osc.start(now);
        osc.stop(now + 0.18);
      }
    } catch (e) {}
  }

  triggerVibrate(type = 'success') {
    if ('vibrate' in navigator) {
      try {
        if (type === 'step1') {
          navigator.vibrate(30);
        } else if (type === 'duplicate') {
          navigator.vibrate([80, 40, 80]);
        } else {
          navigator.vibrate([60, 40, 90]);
        }
      } catch (e) {}
    }
  }

  setFaceValue(value) {
    this.presetType = 'money';
    this.selectedFaceValue = Number(value) || 100;
  }

  setPresetItem(itemName = '商品兌換券') {
    this.presetType = 'item';
    this.presetItemName = itemName;
    this.selectedFaceValue = 0;
  }

  setScanMode(mode) {
    this.scanMode = mode;
    this.resetBuffer();
  }

  resetBuffer() {
    this.collectedCode1 = null;
    this.collectedCode2 = null;
    this.isCardProcessing = false;
    if (this.collectTimer) {
      clearTimeout(this.collectTimer);
      this.collectTimer = null;
    }
  }

  // 判斷是否符合 7-11 主卡號規則：【必須全部為數字，長度 10~24 碼】
  isMainCardNumber(code) {
    if (!code) return false;
    const clean = String(code).trim().replace(/\s+/g, '');
    return /^\d{10,24}$/.test(clean);
  }

  // 判斷是否符合 7-11 第二段檢核碼規則：【嚴格英數字 8 碼，無空格符號，如 B5SJBN13】
  isVerificationCode(code) {
    if (!code) return false;
    const clean = String(code).trim().replace(/\s+/g, '');
    return /^[A-Za-z0-9]{8}$/.test(clean);
  }

  // 啟動相機掃描
  async start(readerElementId, onScanSuccess, onScanError) {
    this.initAudio();
    this.currentBatchCards = [];
    this.recentScans.clear();
    this.resetBuffer();

    if (this.isScanning) {
      await this.stop();
    }

    if (typeof Html5Qrcode === 'undefined') {
      throw new Error('Html5Qrcode 尚未載入完成');
    }

    this.html5QrCode = new Html5Qrcode(readerElementId);

    try {
      this.cameras = await Html5Qrcode.getCameras();
    } catch (e) {}

    const cameraConfig = { facingMode: 'environment' };

    // 取景框高度適度放寬 (寬 88%, 高 150px)，剛好能一次容納商品卡上下兩段條碼
    const qrboxFunction = (viewfinderWidth, viewfinderHeight) => {
      const width = Math.floor(viewfinderWidth * 0.88);
      const height = Math.min(160, Math.floor(viewfinderHeight * 0.42));
      return { width: Math.max(width, 260), height: Math.max(height, 130) };
    };

    const config = {
      fps: 26,
      qrbox: qrboxFunction,
      aspectRatio: 1.333333,
      formatsToSupport: [
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.QR_CODE,
        Html5QrcodeSupportedFormats.UPC_A
      ],
      experimentalFeatures: {
        useBarCodeDetectorIfSupported: true
      }
    };

    const handleSuccess = async (decodedText, decodedResult) => {
      await this.handleIncomingBarcode(decodedText, decodedResult, onScanSuccess);
    };

    try {
      await this.html5QrCode.start(cameraConfig, config, handleSuccess, onScanError);
      this.isScanning = true;

      // 啟動原生多條碼高頻並發掃描輪詢 (若瀏覽器支援 BarcodeDetector 則啟動「一次雙讀」)
      this.startNativeMultiBarcodeLoop(onScanSuccess);

      return true;
    } catch (err) {
      if (this.cameras && this.cameras.length > 0) {
        const fallbackCameraId = this.cameras[this.cameras.length - 1].id;
        await this.html5QrCode.start(fallbackCameraId, config, handleSuccess, onScanError);
        this.isScanning = true;
        this.startNativeMultiBarcodeLoop(onScanSuccess);
        return true;
      }
      throw err;
    }
  }

  // 原生多條碼掃描引擎 (支援在一張畫面中「同時」偵測 2 個條碼)
  startNativeMultiBarcodeLoop(onScanSuccess) {
    if (!('BarcodeDetector' in window)) return;

    try {
      this.nativeBarcodeDetector = new BarcodeDetector({
        formats: ['code_128', 'code_39', 'ean_13', 'qr_code']
      });
    } catch (e) {
      return;
    }

    const checkVideoFrame = async () => {
      if (!this.isScanning) return;

      const video = document.querySelector('#scanner-reader video');
      if (video && video.readyState >= 2 && !this.isCardProcessing) {
        try {
          const detectedBarcodes = await this.nativeBarcodeDetector.detect(video);
          if (detectedBarcodes && detectedBarcodes.length >= 2) {
            // 在同一畫面中同時抓到多個條碼！
            let candidateCode1 = null;
            let candidateCode2 = null;

            for (const b of detectedBarcodes) {
              const val = String(b.rawValue || '').trim().replace(/\s+/g, '');
              if (this.isMainCardNumber(val)) {
                candidateCode1 = val;
              } else if (this.isVerificationCode(val)) {
                candidateCode2 = val.toUpperCase();
              }
            }

            if (candidateCode1 && candidateCode2) {
              // 一次性同時獲取兩段條碼！直接入庫
              await this.finalizeCard(candidateCode1, candidateCode2, onScanSuccess);
            }
          }
        } catch (err) {}
      }

      if (this.isScanning) {
        this.detectLoopId = requestAnimationFrame(checkVideoFrame);
      }
    };

    this.detectLoopId = requestAnimationFrame(checkVideoFrame);
  }

  // 處理收到的單一條碼訊號 (智慧分類與收集窗)
  async handleIncomingBarcode(rawCode, decodedResult, onScanSuccess) {
    if (this.isCardProcessing) return;

    const code = String(rawCode).trim().replace(/\s+/g, '');
    if (!code) return;

    // ==========================================
    // 單段條碼模式
    // ==========================================
    if (this.scanMode === 'single') {
      await this.finalizeCard(code, '', onScanSuccess);
      return;
    }

    // ==========================================
    // 雙段條碼智能收集模式 (嚴格防呆規則)
    // ==========================================
    const isMainCard = this.isMainCardNumber(code);
    const isVerifyCode = this.isVerificationCode(code);

    if (isMainCard) {
      // 這是主卡號 (純數字 10~24 碼)
      if (this.collectedCode1 !== code) {
        this.collectedCode1 = code;
        this.playBeep('step1');
        this.triggerVibrate('step1');

        if (onScanSuccess) {
          onScanSuccess({
            status: 'step1_done',
            code1: code,
            code2: this.collectedCode2,
            batchCount: this.currentBatchCards.length,
            message: `📍 已識別卡號 [末碼 ...${code.slice(-6)}]，正在捕捉 8 碼檢核碼...`
          });
        }
      }
    } else if (isVerifyCode) {
      // 這是檢核碼 (嚴格英數字 8 碼，如 B5SJBN13)
      const cleanVerify = code.toUpperCase();
      if (this.collectedCode2 !== cleanVerify) {
        this.collectedCode2 = cleanVerify;
        this.playBeep('step1');
        this.triggerVibrate('step1');

        if (onScanSuccess) {
          onScanSuccess({
            status: 'step2_detected',
            code1: this.collectedCode1,
            code2: cleanVerify,
            batchCount: this.currentBatchCards.length,
            message: `📍 已識別檢核碼 [${cleanVerify}]，正在捕捉純數字卡號...`
          });
        }
      }
    } else {
      // 既不是純數字主卡號，也不是 8 碼檢核碼 ➔ 防呆直接過濾忽略
      return;
    }

    // 若兩個條碼都已在緩衝窗中湊齊 ➔ 立即完成！
    if (this.collectedCode1 && this.collectedCode2) {
      await this.finalizeCard(this.collectedCode1, this.collectedCode2, onScanSuccess);
      return;
    }

    // 若只抓到其中一段，啟動 2.5 秒超時自動單段存檔計時器 (若另一段真不存在)
    if (!this.collectTimer) {
      this.collectTimer = setTimeout(() => {
        if (this.collectedCode1 && !this.collectedCode2 && !this.isCardProcessing) {
          // 若 2.5 秒內始終沒檢核碼，則存為單段
          this.finalizeCard(this.collectedCode1, '', onScanSuccess);
        }
        this.collectTimer = null;
      }, 2500);
    }
  }

  // 統一結算入庫單張卡片 (同時拍下照片、發出完成音、存入雙庫)
  async finalizeCard(code1, code2, onScanSuccess) {
    if (this.isCardProcessing) return;

    const primaryCode = code1 || code2;
    if (!primaryCode) return;

    // 檢查冷卻與防重
    const now = Date.now();
    const cooldownMs = (window.cardStorage?.settings?.duplicateCooldownSeconds || 2) * 1000;
    if (this.recentScans.has(primaryCode)) {
      const lastScanned = this.recentScans.get(primaryCode);
      if (now - lastScanned < cooldownMs) return;
    }
    this.recentScans.set(primaryCode, now);

    // 檢查是否已在資料庫中
    const existing = window.cardStorage.getCardByCode(primaryCode);
    if (existing) {
      this.playBeep('duplicate');
      this.triggerVibrate('duplicate');
      if (onScanSuccess) {
        onScanSuccess({
          status: 'duplicate',
          code: primaryCode,
          card: existing,
          batchCount: this.currentBatchCards.length,
          message: `⚠️ 卡片已存在（餘額 $${existing.balance}）`
        });
      }
      this.resetBuffer();
      return;
    }

    this.isCardProcessing = true;
    if (this.collectTimer) clearTimeout(this.collectTimer);

    // 即時拍下實體卡照片
    const snapshotPhoto = this.captureVideoSnapshot();

    this.playBeep('success');
    this.triggerVibrate('success');

    try {
      const isItem = this.presetType === 'item';
      const newCard = await window.cardStorage.addCard({
        code: primaryCode,
        code1: code1 || primaryCode,
        code2: code2 || '',
        photoUrl: snapshotPhoto,
        preferredView: snapshotPhoto ? 'photo' : 'barcode',
        cardType: this.presetType,
        itemName: isItem ? (this.presetItemName || '商品兌換券') : '',
        name: isItem ? (this.presetItemName || '商品兌換券') : undefined,
        faceValue: isItem ? 0 : this.selectedFaceValue,
        balance: isItem ? 0 : this.selectedFaceValue,
        note: isItem ? '連掃商品兌換券自動附照片' : (code2 ? '一拍雙讀連掃自動附照片' : '單段連掃自動附照片')
      });

      this.currentBatchCards.push(newCard);

      if (onScanSuccess) {
        onScanSuccess({
          status: 'success',
          card: newCard,
          code1: newCard.code1,
          code2: newCard.code2,
          batchCount: this.currentBatchCards.length,
          message: `🎉 已完成第 ${this.currentBatchCards.length} 張卡片！(卡號+檢核碼+照片已全存)`
        });
      }
    } catch (err) {
      console.error('[Scanner] 存入卡片失敗:', err);
    }

    // 1.0 秒過渡鎖定後重置準備下一張卡片
    setTimeout(() => {
      this.resetBuffer();
    }, 1000);
  }

  // 略過第二段
  async skipSecondBarcode(onScanSuccess) {
    if (this.collectedCode1) {
      await this.finalizeCard(this.collectedCode1, '', onScanSuccess);
    }
  }

  // 自動截圖工具
  captureVideoSnapshot() {
    try {
      const video = document.querySelector('#scanner-reader video');
      if (!video || !video.videoWidth || !video.videoHeight) return '';

      const canvas = document.createElement('canvas');
      const scale = Math.min(1, 900 / video.videoWidth);
      canvas.width = Math.round(video.videoWidth * scale);
      canvas.height = Math.round(video.videoHeight * scale);

      const ctx = canvas.getContext('2d');
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      return canvas.toDataURL('image/jpeg', 0.82);
    } catch (e) {
      return '';
    }
  }

  async stop() {
    if (this.detectLoopId) {
      cancelAnimationFrame(this.detectLoopId);
      this.detectLoopId = null;
    }
    if (this.html5QrCode && this.isScanning) {
      try {
        await this.html5QrCode.stop();
      } catch (e) {}
      this.isScanning = false;
      this.resetBuffer();
    }
  }

  async toggleTorch() {
    if (!this.html5QrCode || !this.isScanning) return false;
    try {
      this.isTorchOn = !this.isTorchOn;
      await this.html5QrCode.applyVideoConstraints({
        advanced: [{ torch: this.isTorchOn }]
      });
      return this.isTorchOn;
    } catch (e) {
      this.isTorchOn = false;
      return false;
    }
  }

  async scanImageFile(file, onScanSuccess) {
    if (!file) return;
    if (!this.html5QrCode) {
      this.html5QrCode = new Html5Qrcode('scanner-hidden-sandbox');
    }
    try {
      const decodedText = await this.html5QrCode.scanFile(file, true);
      await this.handleIncomingBarcode(decodedText, { result: { format: { formatName: 'CODE128' } } }, onScanSuccess);
      return decodedText;
    } catch (e) {
      throw new Error('圖片中未辨識到有效的條碼');
    }
  }
}

window.cardScanner = new CardScanner();

/**
 * 7-11 商品卡皮夾 - 極速批次連續相機掃描模組 (scanner.js)
 * 
 * 升級亮點 (支援 7-11 雙段條碼)：
 * 1. 雙段條碼智能配對模式 (Dual Barcode Mode)：
 *    - 步驟 1：掃描第一段「卡號條碼」➔ 觸發提示音並顯示「請掃第二段檢核碼」
 *    - 步驟 2：掃描第二段「檢核碼條碼」➔ 嗶聲存檔完成！自動進入下一張卡片。
 * 2. 單段條碼極速模式 (Single Barcode Mode)：對準即存。
 * 3. 雙音階 Web Audio 音效：第一段為中高音 (1600Hz)，第二段完成為清脆高音 (2400Hz)。
 */

class CardScanner {
  constructor() {
    this.html5QrCode = null;
    this.isScanning = false;
    this.recentScans = new Map();
    this.currentBatchCards = [];
    this.selectedFaceValue = 100;
    this.audioCtx = null;
    this.currentCameraId = null;
    this.cameras = [];
    this.isTorchOn = false;

    // 雙段條碼掃描狀態
    this.scanMode = 'dual'; // 'dual' | 'single'
    this.pendingCode1 = null; // 暫存的第一段卡號
  }

  // 初始化音效引擎
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

  // 播放音效 (支援第一段過渡音、第二段完成音、重複錯誤音)
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
        // 第一段掃描成功：清脆雙音 (1600Hz -> 1900Hz) 提示準備掃第二段
        osc.type = 'sine';
        osc.frequency.setValueAtTime(1600, now);
        osc.frequency.setValueAtTime(1900, now + 0.05);
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.1);
        osc.start(now);
        osc.stop(now + 0.1);
      } else if (type === 'duplicate') {
        // 重複警告低音
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.setValueAtTime(600, now + 0.08);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
        osc.start(now);
        osc.stop(now + 0.2);
      } else {
        // 完整入庫成功高音 (2400Hz)
        osc.type = 'sine';
        osc.frequency.setValueAtTime(2400, now);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.14);
        osc.start(now);
        osc.stop(now + 0.14);
      }
    } catch (e) {
      console.warn('[Audio] 播放嗶聲失敗:', e);
    }
  }

  // 觸發震動
  triggerVibrate(type = 'success') {
    if ('vibrate' in navigator) {
      try {
        if (type === 'step1') {
          navigator.vibrate(35); // 第一段輕震
        } else if (type === 'duplicate') {
          navigator.vibrate([80, 50, 80]); // 重複雙震
        } else {
          navigator.vibrate(70); // 完成實震
        }
      } catch (e) {}
    }
  }

  setFaceValue(value) {
    this.selectedFaceValue = Number(value) || 100;
  }

  setScanMode(mode) {
    this.scanMode = mode;
    this.pendingCode1 = null;
  }

  // 啟動相機掃描
  async start(readerElementId, onScanSuccess, onScanError) {
    this.initAudio();
    this.currentBatchCards = [];
    this.recentScans.clear();
    this.pendingCode1 = null;

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

    const qrboxFunction = (viewfinderWidth, viewfinderHeight) => {
      const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
      const width = Math.floor(viewfinderWidth * 0.88);
      const height = Math.floor(minEdge * 0.45);
      return { width: Math.max(width, 260), height: Math.max(height, 130) };
    };

    const config = {
      fps: 22,
      qrbox: qrboxFunction,
      aspectRatio: 1.333333,
      formatsToSupport: [
        Html5QrcodeSupportedFormats.CODE_128,
        Html5QrcodeSupportedFormats.CODE_39,
        Html5QrcodeSupportedFormats.EAN_13,
        Html5QrcodeSupportedFormats.EAN_8,
        Html5QrcodeSupportedFormats.QR_CODE,
        Html5QrcodeSupportedFormats.UPC_A,
        Html5QrcodeSupportedFormats.UPC_E,
        Html5QrcodeSupportedFormats.ITF
      ],
      experimentalFeatures: {
        useBarCodeDetectorIfSupported: true
      }
    };

    const handleSuccess = async (decodedText, decodedResult) => {
      await this.processDecodedCode(decodedText, decodedResult, onScanSuccess);
    };

    try {
      await this.html5QrCode.start(cameraConfig, config, handleSuccess, onScanError);
      this.isScanning = true;
      return true;
    } catch (err) {
      if (this.cameras && this.cameras.length > 0) {
        const fallbackCameraId = this.cameras[this.cameras.length - 1].id;
        await this.html5QrCode.start(fallbackCameraId, config, handleSuccess, onScanError);
        this.isScanning = true;
        return true;
      }
      throw err;
    }
  }

  // 處理辨識出的條碼 (雙段條碼與單段條碼智能分支)
  async processDecodedCode(rawCode, decodedResult, onScanSuccess) {
    const code = String(rawCode).trim();
    if (!code) return;

    const now = Date.now();
    const cooldownMs = (window.cardStorage?.settings?.duplicateCooldownSeconds || 2) * 1000;

    // 冷卻檢查
    if (this.recentScans.has(code)) {
      const lastScannedTime = this.recentScans.get(code);
      if (now - lastScannedTime < cooldownMs) {
        return;
      }
    }
    this.recentScans.set(code, now);

    // ==========================================
    // 模式 A: 雙段條碼模式 (7-11 標準實體商品卡)
    // ==========================================
    if (this.scanMode === 'dual') {
      if (!this.pendingCode1) {
        // 第一步：錄入第一段條碼 (主卡號)
        // 檢查是否已存在資料庫
        const existing = window.cardStorage.getCardByCode(code);
        if (existing) {
          this.playBeep('duplicate');
          this.triggerVibrate('duplicate');
          if (onScanSuccess) {
            onScanSuccess({
              status: 'duplicate',
              code: code,
              card: existing,
              batchCount: this.currentBatchCards.length,
              message: `⚠️ 卡片已存在（餘額 $${existing.balance}）`
            });
          }
          return;
        }

        this.pendingCode1 = code;
        this.playBeep('step1');
        this.triggerVibrate('step1');

        if (onScanSuccess) {
          onScanSuccess({
            status: 'step1_done',
            code1: code,
            batchCount: this.currentBatchCards.length,
            message: `📍 已錄入第 1 段卡號 [${code.slice(-6)}]，請接著對準「第 2 段檢核碼」！`
          });
        }
        return;
      } else {
        // 第二步：錄入第二段條碼 (檢核碼)
        // 防止使用者重複掃到同一個第一段條碼
        if (code === this.pendingCode1) {
          return;
        }

        const code1 = this.pendingCode1;
        const code2 = code;
        this.pendingCode1 = null; // 重置暫存

        this.playBeep('success');
        this.triggerVibrate('success');

        try {
          const newCard = await window.cardStorage.addCard({
            code: code1,
            code1: code1,
            code2: code2,
            format: decodedResult?.result?.format?.formatName || 'CODE128',
            faceValue: this.selectedFaceValue,
            balance: this.selectedFaceValue,
            note: '雙段條碼連掃入庫'
          });

          this.currentBatchCards.push(newCard);

          if (onScanSuccess) {
            onScanSuccess({
              status: 'success',
              card: newCard,
              code1: code1,
              code2: code2,
              batchCount: this.currentBatchCards.length,
              message: `✅ 已完成第 ${this.currentBatchCards.length} 張卡片！請繼續掃下一張。`
            });
          }
        } catch (err) {
          console.error('[Scanner] 雙段卡片存入失敗:', err);
        }
        return;
      }
    }

    // ==========================================
    // 模式 B: 單段條碼模式
    // ==========================================
    const existingCard = window.cardStorage.getCardByCode(code);
    if (existingCard) {
      this.playBeep('duplicate');
      this.triggerVibrate('duplicate');
      if (onScanSuccess) {
        onScanSuccess({
          status: 'duplicate',
          code: code,
          card: existingCard,
          batchCount: this.currentBatchCards.length,
          message: `⚠️ 卡片已存在（餘額 $${existingCard.balance}）`
        });
      }
      return;
    }

    this.playBeep('success');
    this.triggerVibrate('success');

    try {
      const newCard = await window.cardStorage.addCard({
        code: code,
        code1: code,
        code2: '',
        format: decodedResult?.result?.format?.formatName || 'CODE128',
        faceValue: this.selectedFaceValue,
        balance: this.selectedFaceValue,
        note: '單段條碼連掃入庫'
      });

      this.currentBatchCards.push(newCard);

      if (onScanSuccess) {
        onScanSuccess({
          status: 'success',
          code: code,
          card: newCard,
          batchCount: this.currentBatchCards.length,
          message: `✅ 已加入：${newCard.name} (面額 $${newCard.faceValue})`
        });
      }
    } catch (err) {
      console.error('[Scanner] 存入卡片失敗:', err);
    }
  }

  // 略過第二段 (直接將暫存的第一段存為單段卡片)
  async skipSecondBarcode(onScanSuccess) {
    if (!this.pendingCode1) return;
    const code = this.pendingCode1;
    this.pendingCode1 = null;

    this.playBeep('success');
    this.triggerVibrate('success');

    const newCard = await window.cardStorage.addCard({
      code: code,
      code1: code,
      code2: '',
      faceValue: this.selectedFaceValue,
      balance: this.selectedFaceValue,
      note: '單段手動完成'
    });

    this.currentBatchCards.push(newCard);
    if (onScanSuccess) {
      onScanSuccess({
        status: 'success',
        card: newCard,
        batchCount: this.currentBatchCards.length,
        message: `✅ 已存為單段卡片：${newCard.name}`
      });
    }
  }

  // 停止相機
  async stop() {
    if (this.html5QrCode && this.isScanning) {
      try {
        await this.html5QrCode.stop();
      } catch (e) {}
      this.isScanning = false;
      this.pendingCode1 = null;
    }
  }

  // 切換手電筒
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

  // 辨識圖片檔案
  async scanImageFile(file, onScanSuccess) {
    if (!file) return;
    if (!this.html5QrCode) {
      this.html5QrCode = new Html5Qrcode('scanner-hidden-sandbox');
    }
    try {
      const decodedText = await this.html5QrCode.scanFile(file, true);
      await this.processDecodedCode(decodedText, { result: { format: { formatName: 'CODE128' } } }, onScanSuccess);
      return decodedText;
    } catch (e) {
      throw new Error('圖片中未辨識到有效的條碼');
    }
  }
}

// 建立全域掃描器物件
window.cardScanner = new CardScanner();

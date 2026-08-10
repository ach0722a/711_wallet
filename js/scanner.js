/**
 * 7-11 商品卡皮夾 - 極速批次連續相機掃描模組 (scanner.js)
 * 
 * 設計思路與技術特色：
 * 1. 連續不中斷批次模式 (Batch Continuous Scan)：鏡頭不關閉，對準即存，連掃 20 張最快只需 20 秒。
 * 2. 雙重防重冷卻保護 (Debounce & Cooldown)：同一條碼 2.5 秒內不重複錄入，並提示「此卡已掃過」。
 * 3. 純原生 Web Audio 嗶嗶聲與觸覺震動：零延遲、不依賴外部音檔，離線 100% 可用。
 * 4. 浮動掃描計數 HUD 與動態光條：即時視覺與聽覺雙重回饋。
 * 5. 支援手電筒補光燈 (Torch) 與圖片檔案辨識。
 */

class CardScanner {
  constructor() {
    this.html5QrCode = null;
    this.isScanning = false;
    this.recentScans = new Map(); // 紀錄 code -> timestamp 防止重複連刷
    this.currentBatchCards = []; // 本次批次掃描入庫清單
    this.selectedFaceValue = 100;
    this.audioCtx = null;
    this.currentCameraId = null;
    this.cameras = [];
    this.isTorchOn = false;
  }

  // 初始化音效引擎 (Web Audio API)
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

  // 播放經典超商掃碼「嗶！」聲 (雙音調快速合成，清脆響亮)
  playBeep(isDuplicate = false) {
    try {
      this.initAudio();
      if (!this.audioCtx) return;

      const now = this.audioCtx.currentTime;
      const osc = this.audioCtx.createOscillator();
      const gain = this.audioCtx.createGain();

      osc.connect(gain);
      gain.connect(this.audioCtx.destination);

      if (isDuplicate) {
        // 重複掃描時發出低音雙嗶提示 (800Hz -> 600Hz)
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(800, now);
        osc.frequency.setValueAtTime(600, now + 0.08);
        gain.gain.setValueAtTime(0.2, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
        osc.start(now);
        osc.stop(now + 0.2);
      } else {
        // 成功辨識發出清脆高音嗶聲 (2400Hz)
        osc.type = 'sine';
        osc.frequency.setValueAtTime(2400, now);
        gain.gain.setValueAtTime(0.3, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
        osc.start(now);
        osc.stop(now + 0.12);
      }
    } catch (e) {
      console.warn('[Audio] 播放嗶聲失敗:', e);
    }
  }

  // 觸發手機震動回饋
  triggerVibrate(isDuplicate = false) {
    if ('vibrate' in navigator) {
      try {
        if (isDuplicate) {
          navigator.vibrate([80, 50, 80]); // 重複短震兩下
        } else {
          navigator.vibrate(60); // 成功震動一下
        }
      } catch (e) {
        // 某些瀏覽器可能需要使用者互動後才允許震動
      }
    }
  }

  // 設定預設面額 (50, 100, 200, 500, 自訂)
  setFaceValue(value) {
    this.selectedFaceValue = Number(value) || 100;
  }

  // 啟動相機掃描
  async start(readerElementId, onScanSuccess, onScanError) {
    this.initAudio();
    this.currentBatchCards = [];
    this.recentScans.clear();

    if (this.isScanning) {
      await this.stop();
    }

    if (typeof Html5Qrcode === 'undefined') {
      throw new Error('Html5Qrcode 庫尚未載入完成，請檢查網路連線或稍後再試');
    }

    this.html5QrCode = new Html5Qrcode(readerElementId);

    // 取得相機鏡頭清單
    try {
      this.cameras = await Html5Qrcode.getCameras();
    } catch (e) {
      console.warn('[Scanner] 無法枚舉相機清單，嘗試直接使用後置鏡頭:', e);
    }

    // 偏好設定：優先選擇後置廣角鏡頭 (environment)
    const cameraConfig = { facingMode: 'environment' };

    // 掃描框與幀率設定 (針對 1D 條碼寬度最佳化)
    const qrboxFunction = (viewfinderWidth, viewfinderHeight) => {
      const minEdge = Math.min(viewfinderWidth, viewfinderHeight);
      const width = Math.floor(viewfinderWidth * 0.88);
      const height = Math.floor(minEdge * 0.45); // 條碼專用寬矩形
      return { width: Math.max(width, 260), height: Math.max(height, 130) };
    };

    const config = {
      fps: 20, // 高影格率提升辨識速度
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
        useBarCodeDetectorIfSupported: true // 若瀏覽器支援原生 BarcodeDetector 則加速
      }
    };

    const handleSuccess = async (decodedText, decodedResult) => {
      await this.processDecodedCode(decodedText, decodedResult, onScanSuccess);
    };

    try {
      await this.html5QrCode.start(
        cameraConfig,
        config,
        handleSuccess,
        (errorMessage) => {
          if (onScanError) onScanError(errorMessage);
        }
      );
      this.isScanning = true;
      return true;
    } catch (err) {
      console.error('[Scanner] 開啟相機失敗:', err);
      // 若 environment 失敗，嘗試第一顆可用鏡頭
      if (this.cameras && this.cameras.length > 0) {
        try {
          const fallbackCameraId = this.cameras[this.cameras.length - 1].id;
          await this.html5QrCode.start(
            fallbackCameraId,
            config,
            handleSuccess,
            onScanError
          );
          this.isScanning = true;
          return true;
        } catch (fallbackErr) {
          throw fallbackErr;
        }
      }
      throw err;
    }
  }

  // 處理辨識出的條碼核心邏輯 (防重、音效、入庫、回呼)
  async processDecodedCode(rawCode, decodedResult, onScanSuccess) {
    const code = String(rawCode).trim();
    if (!code) return;

    const now = Date.now();
    const cooldownMs = (window.cardStorage?.settings?.duplicateCooldownSeconds || 2.5) * 1000;

    // 1. 檢查是否在冷卻時間內重複掃到
    if (this.recentScans.has(code)) {
      const lastScannedTime = this.recentScans.get(code);
      if (now - lastScannedTime < cooldownMs) {
        return; // 忽略高頻重複觸發
      }
    }

    this.recentScans.set(code, now);

    // 2. 檢查資料庫是否已存在此卡片
    const existingCard = window.cardStorage.getCardByCode(code);
    if (existingCard) {
      this.playBeep(true);
      this.triggerVibrate(true);
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

    // 3. 成功入庫新卡片！
    this.playBeep(false);
    this.triggerVibrate(false);

    try {
      const newCard = await window.cardStorage.addCard({
        code: code,
        format: decodedResult?.result?.format?.formatName || 'CODE128',
        faceValue: this.selectedFaceValue,
        balance: this.selectedFaceValue,
        note: '相機連掃入庫'
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

  // 停止相機掃描
  async stop() {
    if (this.html5QrCode && this.isScanning) {
      try {
        await this.html5QrCode.stop();
      } catch (e) {
        console.warn('[Scanner] 停止相機時產生警告:', e);
      }
      this.isScanning = false;
    }
  }

  // 切換手電筒 (Torch)
  async toggleTorch() {
    if (!this.html5QrCode || !this.isScanning) return false;
    try {
      this.isTorchOn = !this.isTorchOn;
      await this.html5QrCode.applyVideoConstraints({
        advanced: [{ torch: this.isTorchOn }]
      });
      return this.isTorchOn;
    } catch (e) {
      console.warn('[Scanner] 該裝置不支援手電筒補光:', e);
      this.isTorchOn = false;
      return false;
    }
  }

  // 從圖片檔案辨識條碼
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
      throw new Error('圖片中未辨識到有效的條碼或 QR Code');
    }
  }
}

// 建立全域掃描器物件
window.cardScanner = new CardScanner();

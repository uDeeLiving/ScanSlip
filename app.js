document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('file-input');
    const folderInput = document.getElementById('folder-input');
    const dropZone = document.getElementById('drop-zone');
    
    const progressContainer = document.getElementById('batch-progress-container');
    const progressText = document.getElementById('progress-text');
    const progressCount = document.getElementById('progress-count');
    const progressBarFill = document.getElementById('progress-bar-fill');
    
    const resultSection = document.getElementById('result-section');
    const tbody = document.getElementById('results-tbody');
    
    const canvas = document.getElementById('processing-canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    let tesseractWorker = null;

    // --- Events ---
    folderInput.addEventListener('change', (e) => handleFiles(e.target.files));
    fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
    });
    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
    });

    dropZone.addEventListener('drop', (e) => {
        if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files);
    }, false);

    // --- Batch Processing ---
    async function handleFiles(fileList) {
        // กรองเฉพาะไฟล์ภาพ
        const files = Array.from(fileList).filter(f => f.type.startsWith('image/'));
        if (files.length === 0) {
            alert('ไม่พบไฟล์รูปภาพในโฟลเดอร์ที่เลือก');
            return;
        }

        // Reset UI
        tbody.innerHTML = '';
        resultSection.classList.remove('hidden');
        progressContainer.classList.remove('hidden');
        
        // Initialize Worker if not exists
        if (!tesseractWorker) {
            progressText.textContent = "กำลังโหลดโมเดล AI (Tesseract)...";
            tesseractWorker = await Tesseract.createWorker('tha+eng', 1);
        }

        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            
            // Update Progress UI
            progressText.textContent = `กำลังประมวลผลไฟล์: ${file.name}`;
            progressCount.textContent = `${i + 1} / ${files.length}`;
            progressBarFill.style.width = `${((i) / files.length) * 100}%`;

            // Create placeholder row
            const rowId = `row-${i}`;
            const tr = document.createElement('tr');
            tr.id = rowId;
            tr.innerHTML = `
                <td><img src="" class="slip-thumb" id="img-${rowId}"></td>
                <td><div class="loader-spinner"></div> กำลังอ่านข้อมูล...</td>
                <td>-</td>
                <td><span class="badge badge-pending"><div class="loader-spinner"></div> รอคิว</span></td>
            `;
            tbody.appendChild(tr);
            
            // Load image visually
            const imgSrc = URL.createObjectURL(file);
            document.getElementById(`img-${rowId}`).src = imgSrc;

            // Process image
            await processSingleSlip(file, imgSrc, tr);
            
            // Update bar after finish one
            progressBarFill.style.width = `${((i + 1) / files.length) * 100}%`;
        }

        progressText.textContent = "ประมวลผลเสร็จสิ้น!";
        setTimeout(() => { progressContainer.classList.add('hidden'); }, 3000);
    }

    async function processSingleSlip(file, imgSrc, tr) {
        try {
            const img = new Image();
            await new Promise((resolve) => {
                img.onload = resolve;
                img.src = imgSrc;
            });

            // 1. QR Code
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const originalImageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const qrCode = jsQR(originalImageData.data, originalImageData.width, originalImageData.height);
            
            if (!qrCode) {
                updateRowUI(tr, null, null, false, "ไม่พบ QR Code");
                return;
            }

            // 2. Preprocess Image (Grayscale + Contrast) for better OCR
            const processedImgSrc = preprocessImage(canvas, ctx, canvas.width, canvas.height);

            // 3. OCR (using processed image instead of original)
            const { data: { text } } = await tesseractWorker.recognize(processedImgSrc);

            // 4. Match QR & Extract Data
            const isMatch = checkFuzzyMatch(qrCode.data, text);
            const extracted = extractDataFromText(text);

            updateRowUI(tr, extracted, qrCode.data, isMatch, isMatch ? "ผ่านการคัดกรอง" : "เสี่ยง! ข้อมูลไม่ตรง QR");

        } catch (e) {
            console.error(e);
            updateRowUI(tr, null, null, false, "เกิดข้อผิดพลาด");
        }
    }

    function preprocessImage(canvas, ctx, width, height) {
        const imageData = ctx.getImageData(0, 0, width, height);
        const data = imageData.data;
        
        // Increase contrast factor
        const contrast = 70; // 0 to 255
        const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
        
        for (let i = 0; i < data.length; i += 4) {
            let r = data[i];
            let g = data[i+1];
            let b = data[i+2];
            
            // Grayscale (Luminance)
            let gray = 0.299 * r + 0.587 * g + 0.114 * b;
            
            // Apply contrast
            gray = factor * (gray - 128) + 128;
            
            // Thresholding: Blow out light colors (background/watermarks) to white
            if (gray > 170) {
                gray = 255;
            } else if (gray < 0) {
                gray = 0;
            }
            
            data[i] = gray;
            data[i+1] = gray;
            data[i+2] = gray;
        }
        
        ctx.putImageData(imageData, 0, 0);
        return canvas.toDataURL("image/jpeg", 1.0);
    }

    function checkFuzzyMatch(qrData, ocrText) {
        const rawQr = qrData.toLowerCase();
        const noSpaceText = ocrText.replace(/[\s\r\n]+/g, '').toLowerCase();
        
        let longestMatch = "";
        for (let i = 0; i < rawQr.length; i++) {
            for (let j = i + 8; j <= rawQr.length; j++) {
                const sub = rawQr.substring(i, j);
                if (noSpaceText.includes(sub) && sub.length > longestMatch.length) {
                    longestMatch = sub;
                }
            }
        }
        return longestMatch.length >= 8;
    }

    // --- Heuristics Parser ---
    const bankDict = {
        'กสิกร': ['kbank', 'กสิกร', 'k+', 'k-plus'],
        'ไทยพาณิชย์': ['scb', 'ไทยพาณิชย์'],
        'กรุงไทย': ['ktb', 'กรุงไทย', 'krungthai'],
        'กรุงเทพ': ['bbl', 'กรุงเทพ', 'bangkok', 'bualuang'],
        'กรุงศรี': ['bay', 'กรุงศรี', 'krungsri'],
        'ออมสิน': ['ออมสิน', 'gsb'],
        'ทีทีบี': ['ttb', 'ทหารไทย', 'ธนชาต'],
        'พร้อมเพย์': ['พร้อมเพย์', 'promptpay', 'wallet']
    };

    function findBankInText(text) {
        text = text.toLowerCase();
        for (const [bankName, keywords] of Object.entries(bankDict)) {
            if (keywords.some(kw => text.includes(kw))) {
                return bankName;
            }
        }
        return null;
    }

    function extractDataFromText(text) {
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let data = { amount: '-', date: '-', sender: '-', receiver: '-', senderBank: '', receiverBank: '' };

        // 1. Amount
        const amountRegex = /[\d,]+\.\d{2}/g;
        const matches = text.match(amountRegex);
        if (matches) {
            let maxAmt = -1;
            let maxStr = '-';
            matches.forEach(m => {
                let val = parseFloat(m.replace(/,/g, ''));
                if (val > maxAmt) { maxAmt = val; maxStr = m; }
            });
            data.amount = maxStr;
        }

        // 2. Date
        // รองรับจุด (ม.ค. หรือ มค) และช่องว่างที่เพี้ยนจาก OCR
        const dateRegex = /\d{1,2}\s*(ม\.?ค\.?|ก\.?พ\.?|มี\.?ค\.?|เม\.?ย\.?|พ\.?ค\.?|มิ\.?ย\.?|ก\.?ค\.?|ส\.?ค\.?|ก\.?ย\.?|ต\.?ค\.?|พ\.?ย\.?|ธ\.?ค\.?|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s*\d{2,4}/i;
        const dateMatch = text.match(dateRegex);
        if (dateMatch) data.date = dateMatch[0];

        // 3. Sender & Receiver Names (Heuristics based on slip layouts)
        const nameKeywords = ['นาย', 'นาง', 'น.ส.', 'ด.ช.', 'ด.ญ.', 'mr.', 'ms.', 'mrs.', 'บริษัท', 'บจก', 'หจก'];
        
        // กวาดหาคำว่า "จาก" และ "ไปยัง" ก่อน (เพื่อความแม่นยำของ SCB และธนาคารอื่นๆ ที่มี Label ชัดเจน)
        let foundFromLabel = false;
        let foundToLabel = false;

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].toLowerCase();
            let originalLine = lines[i];

            if (line.startsWith('จาก') || line === 'ผู้โอน') {
                foundFromLabel = true;
                // ชื่อผู้โอนมักจะอยู่บรรทัดถัดไป หรือบรรทัดถัดๆ ไป (ข้ามบรรทัดว่าง)
                for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
                    let nextLine = lines[j].replace(/^[o\(\)0-9\-]+/, '').trim(); // ลบพวก O) หรือตัวเลขบัญชีที่ติดมา
                    if (nextLine.length > 3 && !nextLine.match(/^x{3}/i)) {
                        data.sender = lines[j];
                        break;
                    }
                }
            }
            else if (line.startsWith('ไปยัง') || line.startsWith('ผู้รับโอน') || line.startsWith('รับเงิน')) {
                foundToLabel = true;
                // ชื่อผู้รับมักจะอยู่บรรทัดถัดไป
                for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
                    let nextLine = lines[j].replace(/^[o\(\)0-9\-]+/, '').trim();
                    if (nextLine.length > 3 && !nextLine.match(/^x{3}/i)) {
                        data.receiver = lines[j];
                        break;
                    }
                }
            }
        }

        // กรณีที่ไม่มี Label ชัดเจน (เช่น KBank) ให้ใช้กฎ: บน = ผู้โอน, ล่าง = ผู้รับ 
        if (data.sender === '-' || data.receiver === '-') {
            let foundNames = [];
            for (let i = 0; i < lines.length; i++) {
                let line = lines[i].toLowerCase();
                let hasTitle = nameKeywords.some(kw => line.includes(kw));
                if (hasTitle) {
                    foundNames.push(lines[i].replace(/^(จาก|ไปยัง|ผู้โอน|ผู้รับโอน)\s*/, '').trim());
                }
            }
            
            // กฎพื้นฐาน: ชื่อแรกที่เจอคือผู้โอน, ชื่อที่สองคือผู้รับ
            if (data.sender === '-' && foundNames.length >= 1) data.sender = foundNames[0];
            if (data.receiver === '-' && foundNames.length >= 2) data.receiver = foundNames[1];
        }

        // กรณี PromptPay (ไม่มีคำนำหน้า และยังไม่มีชื่อผู้รับ)
        if (data.receiver === '-') {
            const ppLine = lines.find(l => l.includes('พร้อมเพย์') || l.toLowerCase().includes('promptpay') || l.toLowerCase().includes('wallet'));
            if (ppLine) data.receiver = ppLine;
        }

        // 4. Sender & Receiver Banks
        // หาธนาคารผู้โอนจาก 7 บรรทัดแรก (ส่วนหัวสลิป)
        for (let i = 0; i < Math.min(7, lines.length); i++) {
            let bank = findBankInText(lines[i]);
            if (bank && bank !== 'พร้อมเพย์') {
                data.senderBank = bank;
                break;
            }
        }

        // หาธนาคารผู้รับจากบริเวณใต้ชื่อผู้รับ
        let receiverIndex = lines.findIndex(l => l === data.receiver);
        if (receiverIndex !== -1) {
            // ค้นหาในบรรทัดที่เป็นชื่อผู้รับ และ 2 บรรทัดถัดไป
            for (let i = receiverIndex; i < Math.min(receiverIndex + 3, lines.length); i++) {
                let bank = findBankInText(lines[i]);
                if (bank) {
                    data.receiverBank = bank;
                    break;
                }
            }
        }

        // Fallback: ถ้าชื่อผู้รับมีคำว่าพร้อมเพย์ ให้เป็นพร้อมเพย์
        if (!data.receiverBank && data.receiver !== '-') {
            if (data.receiver.includes('พร้อมเพย์') || data.receiver.toLowerCase().includes('promptpay') || data.receiver.toLowerCase().includes('wallet')) {
                data.receiverBank = 'พร้อมเพย์';
            }
        }

        return data;
    }

    function updateRowUI(tr, data, qrData, isSuccess, msg) {
        if (!data) data = { amount: 'ไม่พบ', date: 'ไม่พบ', sender: 'ไม่พบ', receiver: 'ไม่พบ', senderBank: '', receiverBank: '' };

        const senderText = data.senderBank ? `${data.sender} <small style="color:#94A3B8">(${data.senderBank})</small>` : data.sender;
        const receiverText = data.receiverBank ? `${data.receiver} <small style="color:#94A3B8">(${data.receiverBank})</small>` : data.receiver;

        tr.innerHTML = `
            <td><img src="${tr.querySelector('img').src}" class="slip-thumb"></td>
            <td>
                <div class="extracted-data">
                    <span class="data-amount">฿ ${data.amount}</span>
                    <span class="data-date">📅 ${data.date}</span>
                </div>
            </td>
            <td>
                <div class="party-info">
                    <span class="party-from">📤 ${senderText}</span>
                    <span class="party-to">📥 ${receiverText}</span>
                </div>
            </td>
            <td>
                <span class="badge ${isSuccess ? 'badge-success' : 'badge-error'}">
                    ${isSuccess ? '✅' : '❌'} ${msg}
                </span>
            </td>
        `;
    }
});

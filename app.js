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
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const qrCode = jsQR(imageData.data, imageData.width, imageData.height);
            
            if (!qrCode) {
                updateRowUI(tr, null, null, false, "ไม่พบ QR Code");
                return;
            }

            // 2. OCR
            const { data: { text } } = await tesseractWorker.recognize(imgSrc);

            // 3. Match QR & Extract Data
            const isMatch = checkFuzzyMatch(qrCode.data, text);
            const extracted = extractDataFromText(text);

            updateRowUI(tr, extracted, qrCode.data, isMatch, isMatch ? "ผ่านการคัดกรอง" : "เสี่ยง! ข้อมูลไม่ตรง QR");

        } catch (e) {
            console.error(e);
            updateRowUI(tr, null, null, false, "เกิดข้อผิดพลาด");
        }
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
    function extractDataFromText(text) {
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        let data = { amount: '-', date: '-', sender: '-', receiver: '-' };

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

        // 3. Sender & Receiver Names
        const nameKeywords = ['นาย', 'นาง', 'น.ส.', 'ด.ช.', 'ด.ญ.', 'mr.', 'ms.', 'mrs.', 'บริษัท', 'บจก', 'หจก'];
        let foundNames = [];

        for (let i = 0; i < lines.length; i++) {
            let line = lines[i].toLowerCase();
            let originalLine = lines[i];

            // เช็คว่าบรรทัดนี้มีคำนำหน้าชื่อหรือไม่
            let hasTitle = nameKeywords.some(kw => line.includes(kw));
            if (hasTitle) {
                // ลบคำว่า "จาก" หรือ "ไปยัง" หรือ "ชื่อผู้โอน" ออกเผื่อติดมา
                let cleanName = originalLine.replace(/^(จาก|ไปยัง|ผู้โอน|ผู้รับโอน)\s*/, '').trim();
                foundNames.push(cleanName);
            }
        }

        // ถ้าเจอชื่อ 2 ชื่อ กำหนดเป็นผู้โอนและผู้รับ
        if (foundNames.length >= 1) data.sender = foundNames[0];
        if (foundNames.length >= 2) data.receiver = foundNames[1];

        // กรณีไม่พบชื่อด้วยคำนำหน้า ให้ลองใช้ Heuristics แบบ "จาก/ไปยัง"
        if (data.sender === '-') {
            const fromIndex = lines.findIndex(l => l.startsWith('จาก'));
            if (fromIndex !== -1 && lines[fromIndex + 1]) data.sender = lines[fromIndex + 1];
        }
        if (data.receiver === '-') {
            const toIndex = lines.findIndex(l => l.startsWith('ไปยัง'));
            if (toIndex !== -1 && lines[toIndex + 1]) data.receiver = lines[toIndex + 1];
        }

        // กรณีเป็น PromptPay / e-Wallet (ไม่มีคำนำหน้า) และยังไม่พบชื่อผู้รับ
        if (data.receiver === '-') {
            const ppLine = lines.find(l => l.includes('พร้อมเพย์') || l.toLowerCase().includes('promptpay') || l.toLowerCase().includes('wallet'));
            if (ppLine) data.receiver = ppLine;
        }

        return data;
    }

    function updateRowUI(tr, data, qrData, isSuccess, msg) {
        if (!data) data = { amount: 'ไม่พบ', date: 'ไม่พบ', sender: 'ไม่พบ', receiver: 'ไม่พบ' };

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
                    <span class="party-from">📤 ${data.sender}</span>
                    <span class="party-to">📥 ${data.receiver}</span>
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

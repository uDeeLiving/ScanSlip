document.addEventListener('DOMContentLoaded', () => {
    const fileInput = document.getElementById('file-input');
    const dropZone = document.getElementById('drop-zone');
    const resultSection = document.getElementById('result-section');
    const imagePreview = document.getElementById('image-preview');
    
    // Status elements
    const stepQr = document.getElementById('step-qr');
    const descQr = document.getElementById('desc-qr');
    const stepOcr = document.getElementById('step-ocr');
    const descOcr = document.getElementById('desc-ocr');
    const finalResult = document.getElementById('final-result');
    const canvas = document.getElementById('processing-canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    // --- Drag and Drop Logic ---
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.add('dragover'), false);
    });

    ['dragleave', 'drop'].forEach(eventName => {
        dropZone.addEventListener(eventName, () => dropZone.classList.remove('dragover'), false);
    });

    dropZone.addEventListener('drop', (e) => {
        const dt = e.dataTransfer;
        const files = dt.files;
        if (files.length > 0) handleFile(files[0]);
    }, false);

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleFile(e.target.files[0]);
    });

    function resetUI() {
        resultSection.classList.remove('hidden');
        finalResult.innerHTML = '';
        finalResult.className = 'final-result';
        
        stepQr.className = 'step active';
        descQr.textContent = 'กำลังแสกนหา QR Code...';
        
        stepOcr.className = 'step';
        descOcr.textContent = 'กำลังรอคิว...';
    }

    // --- Main Processing Logic ---
    function handleFile(file) {
        if (!file.type.startsWith('image/')) {
            alert('กรุณาอัปโหลดไฟล์รูปภาพเท่านั้น');
            return;
        }

        resetUI();

        const reader = new FileReader();
        reader.onload = (e) => {
            const imgSrc = e.target.result;
            imagePreview.src = imgSrc;
            
            const img = new Image();
            img.onload = () => {
                processImage(img, imgSrc);
            };
            img.src = imgSrc;
        };
        reader.readAsDataURL(file);
    }

    async function processImage(img, imgSrc) {
        try {
            // 1. Setup Canvas for QR reading
            canvas.width = img.width;
            canvas.height = img.height;
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

            // 2. Read QR Code
            const qrCode = jsQR(imageData.data, imageData.width, imageData.height);
            
            if (!qrCode) {
                markStepError(stepQr, descQr, 'ไม่พบ QR Code ในภาพ (อาจเป็นสลิปเก่าหรือสลิปปลอม)');
                showFinalResult(false, 'ไม่ผ่านการคัดกรอง', 'ระบบไม่สามารถตรวจจับ QR Code บนรูปภาพนี้ได้');
                return;
            }

            const refNumber = extractReferenceFromQR(qrCode.data);
            markStepSuccess(stepQr, descQr, `พบรหัสอ้างอิง: ${refNumber}`);

            // 3. Process OCR with Tesseract
            stepOcr.className = 'step active';
            descOcr.textContent = 'กำลังวิเคราะห์ข้อความ (อาจใช้เวลา 3-5 วินาที)...';

            const worker = await Tesseract.createWorker('tha+eng');
            
            // Show progress
            worker.on('log', m => {
                if(m.status === 'recognizing text') {
                    descOcr.textContent = `กำลังวิเคราะห์ข้อความ... ${Math.round(m.progress * 100)}%`;
                }
            });

            const { data: { text } } = await worker.recognize(imgSrc);
            await worker.terminate();

            // 4. Cross check
            const cleanedText = text.replace(/\s+/g, '').toLowerCase();
            const cleanedRef = refNumber.toLowerCase();

            if (cleanedText.includes(cleanedRef)) {
                markStepSuccess(stepOcr, descOcr, 'อ่านข้อความสำเร็จ พบรหัสอ้างอิงตรงกัน!');
                showFinalResult(true, '✅ ผ่านการคัดกรองเบื้องต้น', 'รหัส QR Code ตรงกับข้อมูลที่พิมพ์บนสลิป');
            } else {
                markStepError(stepOcr, descOcr, 'อ่านข้อความสำเร็จ แต่ไม่พบรหัสอ้างอิงนี้บนสลิป!');
                showFinalResult(false, '❌ ความเสี่ยงสูง!', 'รหัสใน QR Code ไม่ตรงกับข้อความบนสลิป อาจถูกตัดต่อแก้ไข');
            }

        } catch (error) {
            console.error("Error processing image:", error);
            showFinalResult(false, 'เกิดข้อผิดพลาด', 'ไม่สามารถประมวลผลรูปภาพได้: ' + error.message);
        }
    }

    // --- Helper Functions ---
    function extractReferenceFromQR(qrData) {
        // หา string ยาวๆ ที่น่าจะเป็น reference (อย่างน้อย 15 ตัวอักษร)
        const matches = qrData.match(/[A-Za-z0-9]{15,30}/g);
        if (matches && matches.length > 0) {
            // คืนค่าตัวที่ยาวที่สุด
            return matches.reduce((a, b) => a.length > b.length ? a : b);
        }
        return qrData; // fallback
    }

    function markStepSuccess(element, textElement, msg) {
        element.className = 'step success';
        textElement.textContent = msg;
    }

    function markStepError(element, textElement, msg) {
        element.className = 'step error';
        textElement.textContent = msg;
    }

    function showFinalResult(isSuccess, title, desc) {
        finalResult.className = `final-result ${isSuccess ? 'success' : 'error'}`;
        finalResult.innerHTML = `
            <h3>${title}</h3>
            <p>${desc}</p>
        `;
    }
});

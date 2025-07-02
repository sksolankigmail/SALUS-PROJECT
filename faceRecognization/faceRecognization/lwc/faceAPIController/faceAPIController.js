import { LightningElement, track, api } from 'lwc';
import savePhotoFile from '@salesforce/apex/FaceAPIController.savePhotoFile';
import { ShowToastEvent } from 'lightning/platformShowToastEvent';
import { loadScript } from 'lightning/platformResourceLoader';
import FACE_API from '@salesforce/resourceUrl/faceApi';

export default class Mol_biometricsCapture extends LightningElement {
    @api contactId;
    @track capturedImage;
    @track isValidatingFace = false;
    @track faceApiInitialized = false;
    videoStream;

    @track showCapturedImage = true;
    @track showOpenCamera = true;
    @track showTakePhoto = false;
    @track showRetake = false;
    @track showPreviewImage = false;

    async connectedCallback() {
        if (!this.faceApiInitialized) {
            try {
                await loadScript(this, FACE_API + '/face-api.min.js');
                await faceapi.nets.tinyFaceDetector.loadFromUri(FACE_API);
                await faceapi.nets.faceLandmark68Net.loadFromUri(FACE_API);
                await faceapi.nets.faceExpressionNet.loadFromUri(FACE_API); // NEW
                this.faceApiInitialized = true;
                console.log('✅ face-api.js and models loaded');
            } catch (err) {
                console.error('❌ Error loading face-api.js', err);
                this.showToast('Error', 'Failed to load face detection library.', 'error');
            }
        }
    }

    startCamera() {
        this.showCapturedImage = true;
        this.showOpenCamera = false;
        this.showTakePhoto = true;
        this.showRetake = false;

        const video = this.template.querySelector('video');
        navigator.mediaDevices.getUserMedia({
            video: { width: 640, height: 480, facingMode: 'user' }
        }).then(stream => {
            this.videoStream = stream;
            video.srcObject = stream;

            video.onloadedmetadata = () => {
                video.play();
                this.detectFaceLoop(); // Start face alignment loop
            };

            if (location.protocol !== 'https:') {
                this.showToast('Error', 'Camera access requires HTTPS connection.', 'error');
                return;
            }
        }).catch(() => {
            this.showToast('Error', 'Camera access denied or not supported.', 'error');
        });
    }

    async detectFaceLoop() {
        const video = this.template.querySelector('video');
        const overlayCanvas = this.template.querySelector('.overlay-canvas');
        const displaySize = { width: video.videoWidth, height: video.videoHeight };
        faceapi.matchDimensions(overlayCanvas, displaySize);

        const detect = async () => {
            const detections = await faceapi
                .detectAllFaces(video, new faceapi.TinyFaceDetectorOptions())
                .withFaceLandmarks();

            const resized = faceapi.resizeResults(detections, displaySize);
            const ctx = overlayCanvas.getContext('2d');
            ctx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
            faceapi.draw.drawDetections(overlayCanvas, resized);
            faceapi.draw.drawFaceLandmarks(overlayCanvas, resized);

            if (this.showTakePhoto) {
                requestAnimationFrame(detect);
            }
        };

        detect();
    }

    async capturePhoto() {
        this.isValidatingFace = true;

        const video = this.template.querySelector('video');
        const photoCanvas = this.template.querySelector('.photo-canvas');
        const overlayCanvas = this.template.querySelector('.overlay-canvas');

        if (!video.videoWidth || !video.videoHeight) {
            await new Promise(resolve => {
                video.onloadedmetadata = () => resolve();
            });
        }

        const width = video.videoWidth;
        const height = video.videoHeight;

        photoCanvas.width = width;
        photoCanvas.height = height;
        overlayCanvas.width = width;
        overlayCanvas.height = height;

        const ctx = photoCanvas.getContext('2d');
        ctx.drawImage(video, 0, 0, width, height);

        const isValid = await this.validateFaceInImage(photoCanvas);
        this.isValidatingFace = false;

        if (!isValid) return;

        this.capturedImage = photoCanvas.toDataURL('image/jpeg');

        this.showCapturedImage = false;
        this.showPreviewImage = true;
        this.showTakePhoto = false;
        this.showRetake = true;

        this.videoStream.getTracks().forEach(track => track.stop());
    }

    async validateFaceInImage(canvas) {
        try {
            const detections = await faceapi
                .detectAllFaces(canvas, new faceapi.TinyFaceDetectorOptions())
                .withFaceLandmarks()
                .withFaceExpressions();

            if (!detections || detections.length !== 1) {
                this.showToast('Error', 'Ensure only your face is clearly visible in the camera.', 'error');
                return false;
            }

            const detection = detections[0];
            const landmarks = detection.landmarks;

            const mouth = landmarks.getMouth();
            const leftEye = landmarks.getLeftEye();
            const rightEye = landmarks.getRightEye();
            const nose = landmarks.getNose();
            const jaw = landmarks.getJawOutline();

            // Check for full landmark availability
            if (!mouth || mouth.length < 19 || !leftEye || !rightEye || !nose || !jaw || jaw.length < 9) {
                this.showToast('Error', 'Face landmarks incomplete. Try again.', 'error');
                return false;
            }

            const box = detection.detection.box;

            // Check face centering
            const centerX = canvas.width / 2;
            const centerY = canvas.height / 2;
            const faceCenterX = box.x + box.width / 2;
            const faceCenterY = box.y + box.height / 2;
            const offsetX = Math.abs(centerX - faceCenterX);
            const offsetY = Math.abs(centerY - faceCenterY);
            if (offsetX > canvas.width * 0.2 || offsetY > canvas.height * 0.2) {
                this.showToast('Error', 'Center your face in the frame.', 'error');
                return false;
            }

            // Check for horizontal head tilt (roll)
            const eyeDx = Math.abs(leftEye[0].x - rightEye[3].x);
            const eyeDy = Math.abs(leftEye[0].y - rightEye[3].y);
            const tiltAngle = Math.atan2(eyeDy, eyeDx) * (180 / Math.PI);
            if (Math.abs(tiltAngle) > 10) {
                this.showToast('Error', 'Keep your head straight and face the camera directly.', 'error');
                return false;
            }

            // Check for mouth openness
            const mouthHeight = Math.abs(mouth[14].y - mouth[18].y);
            const mouthWidth = Math.abs(mouth[12].x - mouth[16].x);
            const mouthRatio = mouthHeight / mouthWidth;
            if (mouthRatio > 0.35) {
                this.showToast('Error', 'Please close your mouth and maintain a neutral expression.', 'error');
                return false;
            }

            // Expression check
            const expressions = detection.expressions;
            const exaggerated = expressions.happy > 0.8 || expressions.surprised > 0.6;
            if (exaggerated) {
                this.showToast('Error', 'Please maintain a neutral expression.', 'error');
                return false;
            }

            // Brightness check
            const ctx = canvas.getContext('2d');
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
            let totalBrightness = 0;
            for (let i = 0; i < imageData.length; i += 4) {
                const brightness = (imageData[i] + imageData[i + 1] + imageData[i + 2]) / 3;
                totalBrightness += brightness;
            }
            const avgBrightness = totalBrightness / (imageData.length / 4);
            if (avgBrightness < 60 || avgBrightness > 200) {
                this.showToast('Error', 'Please adjust lighting. Image too dark or too bright.', 'error');
                return false;
            }

            // Vertical head tilt check (Z-axis)
            const noseTip = nose[3];
            const chin = jaw[8]; // jaw center
            const verticalHeadTilt = Math.abs(noseTip.y - chin.y);
            if (verticalHeadTilt < 30) {
                this.showToast('Error', 'Avoid tilting head back. Keep head straight.', 'error');
                return false;
            }

            // Eye openness check (anti-blink)
            const leftEyeOpen = Math.abs(leftEye[1].y - leftEye[5].y) / Math.abs(leftEye[0].x - leftEye[3].x);
            const rightEyeOpen = Math.abs(rightEye[1].y - rightEye[5].y) / Math.abs(rightEye[0].x - rightEye[3].x);
            if (leftEyeOpen < 0.2 || rightEyeOpen < 0.2) {
                this.showToast('Error', 'Please open your eyes fully.', 'error');
                return false;
            }

            // Face size coverage check
            const faceArea = box.width * box.height;
            const canvasArea = canvas.width * canvas.height;
            const faceRatio = faceArea / canvasArea;
            if (faceRatio < 0.1) {
                this.showToast('Error', 'Face is too small or partially blocked. Make sure your face is clearly visible.', 'error');
                return false;
            }

            // Passed all checks
            return true;

        } catch (error) {
            console.error('Face validation failed', error);
            this.showToast('Error', 'Face validation error occurred.', 'error');
            return false;
        }
    }

handleSave() {
    console.log('Saving photo for contactId:', this.contactId); // Confirm it’s not null

    if (!this.contactId) {
        this.showToast('Error', 'Contact ID not found. Please restart the process.', 'error');
        return;
    }

    const fileName = 'biometric_photo.jpg';
    const base64Data = this.capturedImage?.split(',')[1];

    savePhotoFile({
        base64Data: base64Data,
        fileName: fileName,
        contactId: this.contactId
    })
    .then((result) => {
        console.log('✅ File saved with ContentVersion Id:', result);
        this.showToast('Success', 'Biometric image saved successfully.', 'success');

        // Notify parent
        this.dispatchEvent(new CustomEvent('photocaptured', {
            detail: this.capturedImage
        }));
    })
    .catch((error) => {
        console.error('❌ Error saving biometric image:', error);
        this.showToast('Error', 'Failed to save biometric image.', 'error');
    });
}
    handleBack() {
        this.dispatchEvent(new CustomEvent('back'));
    }

    handleRetake() {
        this.showCapturedImage = true;
        this.showPreviewImage = false;
        this.showRetake = false;
        this.showTakePhoto = true;
        setTimeout(() => {
            this.startCamera();
        }, 0);

    }

    disconnectedCallback() {
        if (this.videoStream) this.videoStream.getTracks().forEach(t => t.stop());
    }

    showToast(title, msg, variant) {
        this.dispatchEvent(new ShowToastEvent({ title, message: msg, variant }));
    }

    handleBack() {
        this.dispatchEvent(new CustomEvent('biometriback', { bubbles: true, composed: true }));
    }
}
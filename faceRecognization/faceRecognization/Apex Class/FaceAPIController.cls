public with sharing class FaceAPIController {
    @AuraEnabled
public static String savePhotoFile(String base64Data, String fileName, Id contactId) {
    try {
        ContentVersion cv = new ContentVersion();
        cv.VersionData = EncodingUtil.base64Decode(base64Data);
        cv.Title = fileName;
        cv.PathOnClient = fileName;
        insert cv;

        cv = [SELECT ContentDocumentId FROM ContentVersion WHERE Id = :cv.Id LIMIT 1];

        ContentDocumentLink link = new ContentDocumentLink();
        link.ContentDocumentId = cv.ContentDocumentId;
        link.LinkedEntityId = contactId;
        link.ShareType = 'V'; 
        link.Visibility = 'AllUsers';
        insert link;

        return cv.Id;

    } catch (Exception e) {
        throw new AuraHandledException('Error saving file: ' + e.getMessage());
    }
}

}
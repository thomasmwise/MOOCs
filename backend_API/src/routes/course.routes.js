
const router = require("express").Router();

const { createCourse, getCourses, deleteCourse, updateCourse, uploadVideo, getVideo, updateVideo } = require("../controllers/course.controllers")
const permit = require("../middlewares/permission_handler")
const { basicAuth } = require("../middlewares/auth")

// router.all('/', basicAuth)

router
    .post("/new", permit("Admin"), createCourse)
    .get("/", permit("Admin EndUser"), getCourses)
    .patch("/update/:id", permit("Admin"), updateCourse)
    .delete("/delete/:courseId", permit("Admin"), deleteCourse)

router
    .post("/video/upload", permit("Admin"), uploadVideo)
    .get("/course/video", permit("Admin EndUser"), getVideo)
    .patch("/video/update/:id", permit("Admin"), updateVideo)



module.exports = router

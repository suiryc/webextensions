import sbt._
import Keys._

lazy val versions = Map[String, String](
  "circe"                       -> "0.10.0-M1",
  "readable-stream"             -> "0.4.2",
  "scala"                       -> "2.12.6",
  "webext-native-messaging-app" -> "1.0-SNAPSHOT"
)


lazy val webextNativeMesagingApp = project.in(file(".")).
  enablePlugins(ScalaJSPlugin).
  settings(
    organization := "suiryc",
    name := "webext-native-messaging-app",
    version := versions("webext-native-messaging-app"),
    scalaVersion := versions("scala"),

    scalacOptions ++= Seq(
      "-deprecation",
      "-encoding", "UTF-8",
      "-feature",
      // See: (sjs < 1.0) https://www.scala-js.org/doc/interoperability/sjs-defined-js-classes.html
      "-P:scalajs:sjsDefinedByDefault",
      "-unchecked",
      "-Xfatal-warnings",
      "-Xlint",
      "-Yno-adapted-args",
      "-Ywarn-numeric-widen",
      "-Ywarn-value-discard",
      "-Ywarn-inaccessible",
      "-Ywarn-infer-any",
      //"-Ywarn-dead-code",
      "-Ywarn-nullary-override",
      "-Ywarn-nullary-unit",
      "-Ywarn-unused",
      "-Ywarn-unused-import"
    ),
    resolvers += Resolver.mavenLocal,

    // Module support needed for 'readable-stream'
    scalaJSModuleKind := ModuleKind.CommonJSModule,
    scalaJSUseMainModuleInitializer := true,

    libraryDependencies ++= Seq(
      "io.circe" %%% "circe-core",
      "io.circe" %%% "circe-generic",
      "io.circe" %%% "circe-parser"
    ).map(_ % versions("circe")),
    libraryDependencies +=
      "io.scalajs.npm" %%% "readable-stream" % versions("readable-stream"),

    skip in packageJSDependencies := false,
    jsDependencies +=
      "org.webjars"    %   "requirejs"       % "2.3.5" / "require.js" minified "require.min.js",

    publishMavenStyle := true,
    publishTo := Some(Resolver.mavenLocal)
  )

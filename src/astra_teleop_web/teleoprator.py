import asyncio
import logging

import numpy as np
from pytransform3d import transformations as pt
from pytransform3d import rotations as pr
import math

from astra_teleop.process import get_solve
from astra_teleop_web.webserver import WebServer

logger = logging.getLogger(__name__)

GRIPPER_MAX = 0.055
INITIAL_LIFT_DISTANCE = 0.8

WALKING_HEAD_TILT = 0.26

class Teleopoperator:
    def __init__(self):
        self.solve = get_solve(scale=1.0) # scale means to amplify motion
        
        self.webserver = WebServer()
        self.webserver.on_hand = self.hand_cb
        self.webserver.on_pedal = self.pedal_cb
        self.webserver.on_control = self.control_cb
        
        self.on_pub_goal = None
        self.on_pub_gripper = None
        self.on_pub_head = None
        self.on_cmd_vel = None
        
        self.on_get_current_eef_pose = None
        self.on_get_initial_eef_pose = None
        self.on_reset = None
        self.on_done = None
        
        self.arm_mode = False
        self.percise_mode = False
        self.lift_distance = INITIAL_LIFT_DISTANCE
        self.teleop_enabled = True

        # self.Tscam = {
        #     "left": np.array([
        #         [0, 0, -1, 1.0], 
        #         [1, 0, 0, 0.5], 
        #         [0, -1, 0, INITIAL_LIFT_DISTANCE], 
        #         [0, 0, 0, 1], 
        #     ]), 
        #     "right": np.array([
        #         [0, 0, -1, 1.0], 
        #         [1, 0, 0, -0.5], 
        #         [0, -1, 0, INITIAL_LIFT_DISTANCE], 
        #         [0, 0, 0, 1], 
        #     ]),
        # }

        self.Tscam = { "left": None, "right": None, }
        
        self.Tcamgoal_last = { "left": None, "right": None }
        
    def reset_Tscam(self, side):
        if self.Tcamgoal_last[side] is None:
            self.webserver.control_datachannel_log(f"Connect capture and making sure {side} are in the camera view!")
            raise Exception(f"Connect capture and making sure {side} are in the camera view!")

        Tsgoal = self.on_get_current_eef_pose(side)
        Tcamgoal = self.Tcamgoal_last[side]
        self.Tscam[side] = Tsgoal @ np.linalg.inv(Tcamgoal)
        logger.info(f"Tscam ({side}): \n{str(self.Tscam[side])}")

    async def reset_arm(self):    
        self.arm_mode = False
        
        goal_pose = {
            "left": self.on_get_initial_eef_pose("left"),
            "right": self.on_get_initial_eef_pose("right"),
        }
        self.lift_distance = INITIAL_LIFT_DISTANCE

        while True:
            ok = { "left": False, "right": False }
            for side in ["left", "right"]:
                curr_pose = self.on_get_current_eef_pose(side)
                
                goal_pose_pq = pt.pq_from_transform(goal_pose[side])
                curr_pose_pq = pt.pq_from_transform(curr_pose)
                
                pos_dist = math.dist(goal_pose_pq[:3], curr_pose_pq[:3])
                rot_dist = pr.quaternion_dist(
                    goal_pose_pq[3:],
                    curr_pose_pq[3:]
                )
            
                logger.info(f"Resetting {side}: pos_dist {pos_dist}m, rot_dist {rot_dist}rad, curr_pose: \n{curr_pose}")
            
                if (pos_dist < 0.02 and rot_dist < 0.03):
                    ok[side] = True

            if ok["left"] and ok["right"]:
                break
            
            for side in ["left", "right"]:
                self.on_pub_goal(side, goal_pose[side])
                self.on_pub_gripper(side, GRIPPER_MAX)
            
            self.on_pub_head(0, self.get_head_tilt(self.lift_distance))
            
            await asyncio.sleep(0.1)
        
        await self.teleop_mode_arm(percise_mode=True)
        self.on_reset()
        self.webserver.control_datachannel_log("Reset event")
        logger.info("Reset event")
    
    def get_head_tilt(self, lift_distance):
        point0_lift = 0
        point0_tilt = 1.36
        point1_lift = 0.8
        point1_tilt = 1.06
        
        return point0_tilt + (point1_tilt - point0_tilt) * (lift_distance - point0_lift) / (point1_lift - point0_lift)

    def hand_cb(self, camera_matrix, distortion_coefficients, corners, ids):
        Tcamgoal = {}

        Tcamgoal["left"], Tcamgoal["right"] = self.solve(
            camera_matrix, distortion_coefficients,
            aruco_corners=corners, aruco_ids=ids,
            debug=False,
            debug_image=None,
        ) # 1ms@1080p
        
        for side in ["left", "right"]:
            if Tcamgoal[side] is not None:
                if self.Tcamgoal_last[side] is None:
                    self.Tcamgoal_last[side] = Tcamgoal[side]

                if self.percise_mode:
                    # low_pass_coff = 0.1
                    # Tcamgoal[side] = pt.transform_from_pq(pt.pq_slerp(
                    #     pt.pq_from_transform(self.Tcamgoal_last[side]),
                    #     pt.pq_from_transform(Tcamgoal[side]),
                    #     low_pass_coff
                    # ))

                    # trust for sensor read (in this case, opencv on web client)
                    p_low_pass_coff = 0.1
                    q_low_pass_coff = 0.1
                    pq_camgoal_last = pt.pq_from_transform(self.Tcamgoal_last[side])
                    pq_camgoal = pt.pq_from_transform(Tcamgoal[side])
                    p = pq_camgoal_last[:3] * (1 - p_low_pass_coff) + pq_camgoal[:3] * p_low_pass_coff
                    q = pr.quaternion_slerp(pq_camgoal_last[3:], pq_camgoal[3:], q_low_pass_coff, shortest_path=True)
                    Tcamgoal[side] = pt.transform_from_pq(np.concatenate([p, q]))

                self.Tcamgoal_last[side] = Tcamgoal[side]

        if self.teleop_enabled:
            for side in ["left", "right"]:
                if self.Tcamgoal_last[side] is None:
                    self.webserver.control_datachannel_log(f"Connect capture and making sure {side} are in the camera view!")
                    raise Exception(f"Connect capture and making sure {side} are in the camera view!")

            for side in ["left", "right"]:
                if self.Tscam[side] is None:
                    # self.webserver.control_datachannel_log(f"Reset {side} arm first!")
                    # raise Exception(f"Reset {side} arm first!")
                    return
            
            for side in ["left", "right"]:
                Tsgoal = self.Tscam[side] @ self.Tcamgoal_last[side]
                self.on_pub_goal(side, Tsgoal if self.arm_mode else None, Tscam=self.Tscam[side], Tsgoal_inactive=Tsgoal)
            
            self.on_pub_head(0, self.get_head_tilt(self.lift_distance))
        
    def pedal_cb(self, pedal_real_values):
        pedal_names = ["angular-pos", "angular-neg", "linear-neg", "linear-pos"]
        pedal_names_arm_mode = ["left-gripper", "lift-neg", "lift-pos", "right-gripper"]
        non_sensetive_area = 0.1
        cliped_pedal_real_values = np.clip((np.array(pedal_real_values) - 0.5) / (0.5 - non_sensetive_area) * 0.5 + 0.5, 0, 1)
        if self.arm_mode:
            values = dict(zip(pedal_names_arm_mode, cliped_pedal_real_values))

            LIFT_VEL_MAX = 0.5
            lift_vel = (values["lift-pos"] - values["lift-neg"]) * LIFT_VEL_MAX

            TIME_DELTA = 0.1 # TODO Better solution
            change = lift_vel * TIME_DELTA

            LIFT_DISTANCE_MIN = 0
            LIFT_DISTANCE_MAX = 1.2
            if self.lift_distance + change < LIFT_DISTANCE_MIN or self.lift_distance + change > LIFT_DISTANCE_MAX:
                self.webserver.control_datachannel_log("Lift over limit")
                logger.warn("Lift over limit")
            elif change:
                self.Tscam["left"][2,3] += change
                self.Tscam["right"][2,3] += change
                self.lift_distance += change
                logger.info("lift_distance changed")
                logger.info(str(self.lift_distance))
            
            left_gripper_pos = (1 - values["left-gripper"]) * GRIPPER_MAX
            right_gripper_pos = (1 - values["right-gripper"]) * GRIPPER_MAX
            
            if self.teleop_enabled:
                self.on_pub_gripper("left", left_gripper_pos)
                self.on_pub_gripper("right", right_gripper_pos)
        else:
            values = dict(zip(pedal_names, cliped_pedal_real_values))

            LINEAR_VEL_MAX = 1
            ANGULAR_VEL_MAX = 1
            linear_vel = (values["linear-pos"] - values["linear-neg"]) * LINEAR_VEL_MAX
            angular_vel = (values["angular-pos"] - values["angular-neg"]) * ANGULAR_VEL_MAX * (-1 if linear_vel < 0 else 1)

            if self.teleop_enabled:
                self.on_cmd_vel(linear_vel, angular_vel)
                self.on_pub_head(0, WALKING_HEAD_TILT)
                
    async def teleop_mode_arm(self, percise_mode=None):
        if percise_mode is None:
            percise_mode = self.percise_mode
        self.solve = get_solve(scale=0.5 if percise_mode == "percise_mode" else 1.0)
        self.Tscam = { "left": None, "right": None, }
        self.Tcamgoal_last = { "left": None, "right": None }
        while True: # wait for new tag result
            if self.Tcamgoal_last["left"] is not None and self.Tcamgoal_last["right"] is not None:
                break
            await asyncio.sleep(0.1)
        self.reset_Tscam("left")
        self.reset_Tscam("right")
        self.percise_mode = percise_mode
        self.arm_mode = True
        if percise_mode == "more_percise":
            self.webserver.control_datachannel_log("More Percise Arm Move Teleop Mode")
            logger.info("More Percise Arm Move Teleop Mode")
        elif percise_mode:
            self.webserver.control_datachannel_log("Percise Arm Move Teleop Mode")
            logger.info("Percise Arm Move Teleop Mode")
        else:
            self.webserver.control_datachannel_log("Arm Move Teleop Mode")
            logger.info("Arm Move Teleop Mode")
    
    async def control_cb(self, control_type):
        self.webserver.control_datachannel_log(f"Cmd: {control_type}")
        logger.info(f"Cmd: {control_type}")
        if control_type == "reset":
            await self.reset_arm()
        elif control_type == "done":
            self.on_done()
            self.webserver.control_datachannel_log("Done event")
            logger.info("Done event")
        elif control_type == "teleop_mode_base":
            self.arm_mode = False
            self.webserver.control_datachannel_log("Base Move Teleop Mode")
            logger.info("Base Move Teleop Mode")
        elif control_type == "teleop_mode_arm":
            await self.teleop_mode_arm(percise_mode=False)
        elif control_type == "teleop_mode_percise":
            await self.teleop_mode_arm(percise_mode=True)
        elif control_type == "teleop_mode_more_percise":
            await self.teleop_mode_arm(percise_mode="more_percise")
            
    def ik_failed_cb(self, side):
        self.webserver.loop.call_soon_threadsafe(self.webserver.control_datachannel_log, f"IK failed: {side}")
        logger.info(f"IK failed: {side}")
